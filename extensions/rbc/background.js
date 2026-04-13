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

    // If port already exists and is valid, we're done
    if (this._port) return;

    // Check if offscreen document already exists
    const hasDoc = await chrome.offscreen.hasDocument?.() ?? false;
    if (!hasDoc) {
      console.log('[RBC] Creating offscreen document...');
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['WEB_RTC'],
          justification: 'Maintain persistent WebSocket connection to BAP Gateway'
        });
      } catch (err) {
        console.error('[RBC] createDocument failed:', err.message);
        // Don't throw — schedule retry and let service worker stay alive
        setTimeout(() => this._scheduleOffscreenRetry(), 3000);
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // Try to connect to offscreen
    if (!this._port) {
      console.log('[RBC] Connecting port to offscreen...');
      // chrome.runtime.connect can fail with "Extension context invalidated"
      // when the service worker was just restarted — schedule retry and return
      let port = null;
      chrome.runtime.lastError = null;
      try {
        port = chrome.runtime.connect(chrome.runtime.id, { name: OFFSCREEN_PORT_NAME });
      } catch (err) {
        // Synchronous throw — extremely rare but handle it
        console.error('[RBC] connect() threw synchronously:', err.message);
        setTimeout(() => this._scheduleOffscreenRetry(), 2000);
        return;
      }

      // Check lastError AFTER connect — this is the most common failure mode in MV3
      const lastErr = chrome.runtime.lastError?.message;
      if (lastErr) {
        console.error('[RBC] connect lastError:', lastErr);
        // Port was created but is immediately dead — release it so hasDocument stays accurate
        try { port?.disconnect(); } catch {}
        setTimeout(() => this._scheduleOffscreenRetry(), 2000);
        return;
      }

      this._port = port;
      this._port.onMessage.addListener((msg) => this._handlePortMessage(msg));
      this._port.onDisconnect.addListener(() => {
        this._port = null;
        this._emit('offscreen_dead', {});
        // Automatically retry after disconnect
        setTimeout(() => this._scheduleOffscreenRetry(), 2000);
      });
      console.log('[RBC] Offscreen port established');
    }
  }

  _scheduleOffscreenRetry() {
    if (!this._port && this.config.autoConnect && this.config.serverUrl && this.config.token) {
      console.log('[RBC] Retrying offscreen connection...');
      this._ensureOffscreen().catch(err => {
        console.error('[RBC] Offscreen retry failed:', err.message);
      });
    }
  }

  _sendPortMsg(msg) {
    return new Promise((resolve) => {
      if (!this._port) { resolve({ ok: false, error: 'No port' }); return; }
      const id = ++this._msgId;
      msg._id = id;
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, error: 'Timeout waiting for offscreen response' });
      }, 5000); // Reduced from 10s for faster failure
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
    this._offscreen = new OffscreenClient();

    // Offscreen events → update local state
    this._offscreen.on('connected', () => {
      this.connected = true;
      this._updateStatus('connected', 'Connected');
      this._broadcast({ type: 'connected', sessionId: this.sessionId });
      this._startHeartbeat();
    });

    this._offscreen.on('disconnected', ({ code }) => {
      this.connected = false;
      this.sessionId = null;
      this._stopHeartbeat();
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
      // Don't throw — caller handles it gracefully; offscreen retry will be scheduled
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
          this._send({ type: 'command_response', id: msg.id, ...response })
            .then(ok => { if (!ok) console.warn('[RBC] Failed to send command_response for', msg.id); });
        });
        break;
      case 'command_response':
        break;
      default:
        if (msg.type?.startsWith('tab_')) {
          const tabId = msg.type.split('_')[1];
          this._sendToTab(tabId, msg.method, msg.params)
            .then(result => this._send({ type: 'command_response', id: msg.id, result }))
            .catch(err => this._send({ type: 'command_response', id: msg.id, error: { code: -32000, message: err.message } }));
        }
    }
  }

  _handleEvent(event, data) {
    // Events from gateway are currently informational only (no waiter system).
    // Future: could add event subscription/waiting if needed.
  }

  disconnect() {
    this._stopHeartbeat();
    this.sessionId = null;
    this.connected = false;
    this._offscreen.disconnect().catch(() => {});
    this._updateStatus('disconnected', 'Disconnected');
    this._broadcast({ type: 'status', status: 'disconnected', text: 'Disconnected' });
  }

  _send(data) { return this._offscreen.send(data); }

  async _sendToTab(tabId, method, params) {
    const numericTabId = parseInt(tabId, 10);
    if (isNaN(numericTabId)) throw new Error(`Invalid tabId: ${tabId}`);
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(numericTabId, { type: 'execute', command: method, params: params || {} }, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

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
    // Helper: resolve target tab (supports optional params.tabId)
    const resolveTab = (callback) => {
      if (params?.tabId) { callback(params.tabId); }
      else { chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => callback(tabs[0]?.id || null)); }
    };

    const respondOk = (result) => { try { sendResponse({ id, result }); } catch {} };
    const respondErr = (msg) => { try { sendResponse({ id, error: { code: -32000, message: msg } }); } catch {} };

    // Helper: forward command to content script in target tab
    const forwardToContent = () => {
      resolveTab((tabId) => {
        if (!tabId) { respondErr('No active tab'); return; }
        let done = false;
        const timeout = setTimeout(() => {
          if (!done) { done = true; respondErr(`Timeout: ${method}`); }
        }, 60000);

        chrome.tabs.sendMessage(tabId, { type: 'execute', command: method, params: params || {} }, (resp) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          if (chrome.runtime.lastError) { respondErr(chrome.runtime.lastError.message); }
          else if (resp?.error) { try { sendResponse({ id, error: resp.error }); } catch {} }
          else { respondOk(resp); }
        });
      });
    };

    // ── Background-handled commands (chrome.tabs API required) ──
    switch (method) {
      case 'browser.navigate':
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          chrome.tabs.update(tabId, { url: params.url }, () => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true });
          });
        });
        return;

      case 'browser.newTab':
        chrome.tabs.create({ url: params?.url || 'about:blank', active: params?.active !== false }, (tab) => {
          if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
          else respondOk({ success: true, tabId: tab.id, url: tab.url || tab.pendingUrl });
        });
        return;

      case 'browser.closeTab': {
        const doClose = (tabId) => {
          chrome.tabs.remove(tabId, () => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true });
          });
        };
        if (params?.tabId) doClose(params.tabId);
        else resolveTab((tabId) => { tabId ? doClose(tabId) : respondErr('No active tab'); });
        return;
      }

      case 'browser.switchTab':
        if (!params?.tabId) { respondErr('tabId required'); return; }
        chrome.tabs.update(params.tabId, { active: true }, (tab) => {
          if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
          else respondOk({ success: true, tabId: tab.id, url: tab.url });
        });
        return;

      case 'browser.listTabs':
        chrome.tabs.query({ currentWindow: true }, (tabs) => {
          respondOk({ tabs: tabs.map(t => ({ tabId: t.id, url: t.url, title: t.title, active: t.active, index: t.index })) });
        });
        return;

      default:
        // All other commands → forward to content script
        forwardToContent();
        return;
    }
  }
}

// ============= Global Instance =============

const conn = new RBCConnectionManager();

// Restore state after Service Worker restart.
// loadConfig() already calls connect() if autoConnect is configured,
// and offscreen.js handles the "already connected" case internally.
async function restoreState() {
  await conn.loadConfig();
}

restoreState();

// ============= Message Listeners =============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'popup_connect':
      conn.config.autoConnect = true;
      conn.saveConfig({ autoConnect: true });
      conn.connect().then(() => {
        sendResponse({ success: true });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep channel open for async sendResponse
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
    chrome.tabs.query({ currentWindow: true }).then(tabs => {
      conn._send({
        type: 'event', event: 'page.loaded',
        data: { url: tab.url, title: tab.title, tabId, tabCount: tabs.length }
      });
    });
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url && tab.url.startsWith('http')) {
      conn._send({
        type: 'event', event: 'tab.activated',
        data: { url: tab.url, title: tab.title, tabId: activeInfo.tabId }
      });
    }
  } catch {}
});

chrome.webNavigation?.onCompleted?.addListener((details) => {
  if (details.frameId === 0 && details.url.startsWith('http')) {
    conn._broadcast({ type: 'popup_update', url: details.url });
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
