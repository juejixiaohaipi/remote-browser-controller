// background.js — MV3 Service Worker
// WebSocket lives in offscreen.html (survives SW termination)
// Background SW acts as message router to/from offscreen
//
// IMPORTANT: Reconnection is handled ONLY by offscreen.js.
// Background does NOT have its own reconnect loop.

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_PORT_NAME = 'rbc-offscreen'; // filter port connections by name

// ============= Offscreen Client =============

class OffscreenClient {
  constructor() {
    this._listeners = new Map();
    this._port = null;
    this._pending = new Map();
    this._msgId = 0;

    // Only accept ports from offscreen (filter by name)
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== OFFSCREEN_PORT_NAME) return; // ignore content script ports
      console.log('[RBC] Offscreen port connected');
      this._port = port;
      port.onMessage.addListener((msg) => this._handlePortMessage(msg));
      port.onDisconnect.addListener(() => {
        console.log('[RBC] Offscreen port disconnected');
        this._port = null;
        this._emit('offscreen_dead', {});
      });
    });
  }

  _handlePortMessage(msg) {
    switch (msg.type) {
      case 'connected':
        this._emit('connected', { sessionId: msg.sessionId });
        break;
      case 'disconnected':
        this._emit('disconnected', { code: msg.code });
        break;
      case 'error':
        this._emit('error', { message: msg.message });
        break;
      case 'reconnecting':
        this._emit('reconnecting', { delay: msg.delay, attempt: msg.attempt });
        break;
      case 'message':
        this._emit('message', msg.msg);
        break;
      default: {
        const p = this._pending.get(msg.id);
        if (p) { this._pending.delete(msg.id); clearTimeout(p.timeout); p.resolve(msg); }
      }
    }
  }

  async _ensureOffscreen() {
    if (!chrome.offscreen) {
      throw new Error('chrome.offscreen API not available (Chrome 116+ required)');
    }

    const hasDoc = await chrome.offscreen.hasDocument?.() ?? false;
    if (hasDoc) {
      if (this._port) return;
    } else {
      console.log('[RBC] Creating offscreen document...');
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WEB_RTC'],
        justification: 'Maintain persistent WebSocket connection to BAP Gateway'
      });
      await new Promise(r => setTimeout(r, 500));
    }

    // Establish named port connection to offscreen
    if (!this._port) {
      console.log('[RBC] Connecting port to offscreen...');
      try {
        this._port = chrome.runtime.connect(chrome.runtime.id, { name: OFFSCREEN_PORT_NAME });
        this._port.onMessage.addListener((msg) => this._handlePortMessage(msg));
        this._port.onDisconnect.addListener(() => {
          this._port = null;
          this._emit('offscreen_dead', {});
        });
      } catch (err) {
        console.error('[RBC] Failed to connect to offscreen:', err);
        throw err;
      }
    }
  }

  _sendPortMsg(msg) {
    return new Promise((resolve) => {
      if (!this._port) { resolve({ ok: false, error: 'No port' }); return; }
      const id = ++this._msgId;
      msg._id = id;
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, error: 'Timeout' });
      }, 10000);
      this._pending.set(id, { resolve, timeout });
      try {
        this._port.postMessage({ target: 'offscreen', ...msg });
      } catch (err) {
        clearTimeout(timeout);
        this._pending.delete(id);
        resolve({ ok: false, error: err.message });
      }
    });
  }

  async connect(config) {
    await this._ensureOffscreen();
    await this._sendPortMsg({
      action: 'start',
      serverUrl: config.serverUrl,
      token: config.token,
      deviceId: config.deviceId,
      deviceName: config.deviceName
    });
  }

  async disconnect() {
    try { await this._sendPortMsg({ action: 'stop' }); } catch {}
  }

  async send(data) {
    const resp = await this._sendPortMsg({ action: 'send', data });
    return resp?.ok ?? false;
  }

  async status() {
    const resp = await this._sendPortMsg({ action: 'status' });
    return resp?.connected ?? false;
  }

  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(cb);
  }

  _emit(event, data) {
    const cbs = this._listeners.get(event) || [];
    for (const cb of cbs) try { cb(data); } catch {}
  }
}

// ============= RBC Connection Manager =============

class RBCConnectionManager {
  constructor() {
    this.sessionId = null;
    this.connected = false;
    this.heartbeatTimer = null;
    this.config = { serverUrl: '', token: '', deviceName: '', deviceId: '', autoConnect: false };
    this.status = 'disconnected';
    this.statusText = 'Not connected';
    this._commandWaiters = new Map();
    this._offscreen = new OffscreenClient();

    // Offscreen events → update local state
    this._offscreen.on('connected', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this._updateStatus('connected', 'Connected');
      this._broadcast({ type: 'connected', sessionId: this.sessionId });
      this._startHeartbeat();
    });

    this._offscreen.on('disconnected', ({ code }) => {
      this.connected = false;
      this.sessionId = null;
      this._stopHeartbeat();
      this._clearPendingCommands();
      this._updateStatus('disconnected', `Connection closed (${code})`);
      // NO reconnect here — offscreen handles it
    });

    this._offscreen.on('reconnecting', ({ delay, attempt }) => {
      this._updateStatus('reconnecting', `Reconnecting in ${Math.round(delay/1000)}s (attempt ${attempt})`);
    });

    this._offscreen.on('error', ({ message }) => {
      this._updateStatus('error', `Error: ${message}`);
    });

    this._offscreen.on('message', (msg) => {
      this._handleMessage(msg);
    });

    this._offscreen.on('offscreen_dead', () => {
      this.connected = false;
      this._stopHeartbeat();
      this._updateStatus('disconnected', 'Offscreen terminated');
      // Recreate offscreen if we should be connected
      if (this.config.autoConnect && this.config.serverUrl && this.config.token) {
        setTimeout(() => this.connect(), 2000);
      }
    });
  }

  async loadConfig() {
    const result = await chrome.storage.local.get(['serverUrl','token','deviceName','autoConnect','deviceId']);
    let deviceId = result.deviceId;
    if (!deviceId) { deviceId = crypto.randomUUID(); await chrome.storage.local.set({ deviceId }); }
    this.config = { serverUrl: result.serverUrl||'', token: result.token||'', deviceName: result.deviceName||'', deviceId, autoConnect: result.autoConnect||false };
    if (this.config.autoConnect && this.config.serverUrl && this.config.token) this.connect();
  }

  async saveConfig(newConfig) {
    Object.assign(this.config, newConfig);
    await chrome.storage.local.set({
      serverUrl: this.config.serverUrl, token: this.config.token,
      deviceName: this.config.deviceName, deviceId: this.config.deviceId,
      autoConnect: this.config.autoConnect
    });
  }

  getDeviceId() { return this.config.deviceId || chrome.runtime.id; }

  async connect() {
    if (!this.config.serverUrl || !this.config.token) {
      this._updateStatus('error', 'Server or token not configured');
      return;
    }
    this._updateStatus('connecting', 'Connecting...');
    try {
      await this._offscreen.connect({
        serverUrl: this.config.serverUrl,
        token: this.config.token,
        deviceId: this.getDeviceId(),
        deviceName: this.config.deviceName || `Chrome-${this.getDeviceId().slice(0,8)}`
      });
    } catch (err) {
      console.error('[RBC] connect() error:', err);
      this._updateStatus('error', 'Offscreen init failed: ' + err.message);
    }
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        this.sessionId = msg.sessionId;
        this._updateStatus('connected', `Connected (${msg.sessionId?.slice(0,8)})`);
        this._broadcast({ type: 'connected', sessionId: msg.sessionId });
        break;
      case 'auth_error':
        this._updateStatus('error', `Auth failed: ${msg.error}`);
        break;
      case 'pong': break;
      case 'event': this._handleEvent(msg.event, msg.data); break;
      case 'command':
        this._handleCommand(msg.id, msg.method, msg.params, (response) => {
          this._send({ type: 'command_response', id: msg.id, ...response });
        });
        break;
      case 'command_response':
        this._handleCommandResponse(msg.id, msg.result, msg.error);
        break;
      default:
        if (msg.type?.startsWith('tab_')) {
          const tabId = msg.type.split('_')[1];
          this._sendToTab(tabId, msg.method, msg.params).catch(() => {});
        }
    }
  }

  _handleEvent(event, data) {
    if (this._eventWaiters?.[event]) {
      clearTimeout(this._eventWaiters[event].timeout);
      this._eventWaiters[event].resolve(data);
      delete this._eventWaiters[event];
    }
  }

  disconnect() {
    this._stopHeartbeat();
    this._clearPendingCommands();
    this.sessionId = null;
    this.connected = false;
    this._offscreen.disconnect().catch(() => {});
    this._updateStatus('disconnected', 'Disconnected');
    this._broadcast({ type: 'status', status: 'disconnected', text: 'Disconnected' });
  }

  _clearPendingCommands() {
    for (const [id, waiter] of this._commandWaiters) {
      clearTimeout(waiter.timeout);
      if (!waiter.responded) {
        waiter.responded = true;
        try { waiter.sendResponse({ id, error: { code: -32000, message: 'Disconnected' } }); } catch {}
      }
    }
    this._commandWaiters.clear();
  }

  _handleCommandResponse(id, result, error) {
    const pending = this._commandWaiters.get(id);
    if (!pending || pending.responded) return;
    pending.responded = true;
    clearTimeout(pending.timeout);
    this._commandWaiters.delete(id);
    try { pending.sendResponse({ id, result, error }); } catch {}
  }

  _send(data) { return this._offscreen.send(data); }

  _updateStatus(status, text) {
    this.status = status; this.statusText = text;
    this._broadcast({ type: 'status', status, text });
  }

  _broadcast(message) {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    });
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.connected) this._send({ type: 'ping' });
    }, 25000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  _handleCommand(id, method, params, sendResponse) {
    if (method === 'browser.navigate') {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.update(tabs[0].id, { url: params.url }, () => {
            try { sendResponse({ id, result: { success: true } }); } catch {}
          });
        } else {
          try { sendResponse({ id, error: { code: -32000, message: 'No active tab' } }); } catch {}
        }
      });
      return;
    }

    if (method === 'browser.snapshot') {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.id) {
          try { sendResponse({ id, error: { code: -32000, message: 'No active tab' } }); } catch {}
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'browser.snapshot', params }, (resp) => {
          if (chrome.runtime.lastError) {
            try { sendResponse({ id, error: { code: -32000, message: chrome.runtime.lastError.message } }); } catch {}
          } else {
            try { sendResponse({ id, result: resp }); } catch {}
          }
        });
      });
      return;
    }

    let responded = false;
    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        this._commandWaiters.delete(id);
        try { sendResponse({ id, error: { code: -32000, message: `Timeout: ${method}` } }); } catch {}
      }
    }, 60000);
    this._commandWaiters.set(id, { method, timeout, sendResponse, responded });
    this._send({ type: 'command', id, method, params });
  }
}

// ============= Global Instance =============

const conn = new RBCConnectionManager();
conn.loadConfig();

// ============= Message Listeners =============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'popup_connect':
      conn.config.autoConnect = true;
      conn.saveConfig({ autoConnect: true });
      conn.connect();
      sendResponse({ success: true });
      break;

    case 'popup_disconnect':
      conn.config.autoConnect = false;
      conn.saveConfig({ autoConnect: false });
      conn.disconnect();
      sendResponse({ success: true });
      break;

    case 'popup_status':
      sendResponse({
        status: conn.status,
        config: conn.config,
        sessionId: conn.sessionId,
        deviceName: conn.config?.deviceName || '',
        deviceId: conn.getDeviceId(),
      });
      break;

    case 'popup_save_config':
      conn.saveConfig(message.config).then(() => sendResponse({ success: true }));
      return true;

    case 'popup_get_default_token':
      sendResponse({ token: conn.config.token });
      break;

    case 'content_dialog':
      conn._send({
        type: 'event', event: 'dialog.opened',
        data: { dialogType: message.dialogType, message: message.message }
      });
      sendResponse({ received: true });
      break;

    case 'content_page_loaded':
      conn._send({
        type: 'event', event: 'page.loaded',
        data: { url: message.url, title: message.title }
      });
      sendResponse({ received: true });
      break;

    case 'content_screenshot':
      conn._send({
        type: 'event', event: 'screenshot.captured',
        data: { screenshot: message.screenshot }
      });
      sendResponse({ received: true });
      break;

    case 'capture_visible_tab': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.captureVisibleTab(tabs[0].windowId, { format: 'png' }, (dataUrl) => {
            sendResponse(dataUrl);
          });
        } else {
          sendResponse(null);
        }
      });
      return true;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }
  return true;
});

// ============= Tab Observers =============

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    conn._send({
      type: 'event', event: 'page.loaded',
      data: { url: tab.url, title: tab.title, tabId }
    });
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url && tab.url.startsWith('http')) {
      conn._broadcast({ url: tab.url, title: tab.title });
    }
  } catch {}
});

chrome.webNavigation?.onCompleted?.addListener((details) => {
  if (details.frameId === 0 && details.url.startsWith('http')) {
    conn._broadcast({ url: details.url });
  }
});

// ============= Downloads Observer =============

chrome.downloads.onCreated.addListener((downloadItem) => {
  conn._send({
    type: 'event', event: 'download.started',
    data: { id: downloadItem.id, filename: downloadItem.filename, url: downloadItem.url, mimeType: downloadItem.mime, state: downloadItem.state, startedAt: downloadItem.startTime }
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === 'complete') {
    conn._send({
      type: 'event', event: 'download.complete',
      data: { id: delta.id, filename: delta.filename?.current, state: delta.state.current }
    });
  }
});

console.log('[RBC] Background service worker initialized (offscreen mode)');
