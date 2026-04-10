/**
 * RBC Relay — Chrome Extension (MV3 Service Worker)
 * WebSocket lives in offscreen.html (survives SW termination).
 * Background SW routes messages between offscreen ↔ content scripts ↔ popup.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let relayToken = null;
let deviceName = 'RBC-Relay';
let deviceId = null;
let relayPort = 18792;
let autoConnect = false;
let connected = false;

// ── OffscreenClient — manages offscreen document + MessagePort ───────────────

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_PORT_NAME = 'rbc-relay-offscreen';

class OffscreenClient {
  constructor() {
    this._listeners = new Map();
    this._port = null;
    this._pending = new Map();
    this._msgId = 0;

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== OFFSCREEN_PORT_NAME) return;
      console.log('[RBC-Relay] Offscreen port connected');
      this._port = port;
      port.onMessage.addListener((msg) => this._handlePortMessage(msg));
      port.onDisconnect.addListener(() => {
        this._port = null;
        this._emit('offscreen_dead', {});
      });
    });
  }

  _handlePortMessage(msg) {
    switch (msg.type) {
      case 'connected':
        this._emit('connected', {});
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
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WEB_RTC'],
        justification: 'Maintain persistent WebSocket connection to local relay'
      });
      await new Promise(r => setTimeout(r, 500));
    }
    if (!this._port) {
      try {
        this._port = chrome.runtime.connect(chrome.runtime.id, { name: OFFSCREEN_PORT_NAME });
        this._port.onMessage.addListener((msg) => this._handlePortMessage(msg));
        this._port.onDisconnect.addListener(() => {
          this._port = null;
          this._emit('offscreen_dead', {});
        });
      } catch (err) {
        console.error('[RBC-Relay] Failed to connect to offscreen:', err);
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
      relayPort: config.relayPort,
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

const offscreen = new OffscreenClient();

// ── Load/Save config ──────────────────────────────────────────────────────────

async function loadConfig() {
  const result = await chrome.storage.local.get(['relayPort', 'relayToken', 'deviceName', 'autoConnect', 'deviceId']);
  relayPort = result.relayPort || 18792;
  relayToken = result.relayToken || '';
  deviceName = result.deviceName || 'RBC-Relay';
  autoConnect = result.autoConnect ?? false;
  if (result.deviceId) {
    deviceId = result.deviceId;
  } else {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId });
  }
}

async function saveConfig(cfg) {
  if (cfg.relayPort !== undefined) relayPort = cfg.relayPort;
  if (cfg.relayToken !== undefined) relayToken = cfg.relayToken;
  if (cfg.deviceName !== undefined) deviceName = cfg.deviceName;
  if (cfg.autoConnect !== undefined) autoConnect = cfg.autoConnect;
  await chrome.storage.local.set({
    relayPort,
    relayToken: relayToken || undefined,
    deviceName: deviceName || undefined,
    autoConnect: autoConnect || undefined
  });
}

// ── Status broadcast ──────────────────────────────────────────────────────────

function broadcastStatus(status, text) {
  const msg = { type: 'status', status, text };
  chrome.runtime.sendMessage(msg).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => { if (tab.id) chrome.tabs.sendMessage(tab.id, msg).catch(() => {}); });
  });
}

// ── Send to relay via offscreen ───────────────────────────────────────────────

function sendToRelay(data) {
  offscreen.send(data);
}

// ── Command routing: relay commands → content script ──────────────────────────

function handleRelayMessage(msg) {
  if (msg.type === 'relay_ready') return true; // relay handshake, ignore
  if (msg.type === 'auth_ok') {
    broadcastStatus('connected', `已连接 relay:${relayPort}`);
    return true;
  }
  if (msg.type === 'auth_error') {
    broadcastStatus('error', `认证失败: ${msg.error}`);
    return true;
  }
  if (msg.type === 'pong') return true;
  if (msg.type !== 'command') return false;

  const { id, method, params } = msg;

  // browser.navigate — handle locally
  if (method === 'browser.navigate') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.update(tabs[0].id, { url: params.url }, () => {
          sendToRelay({ type: 'command_response', id, result: { success: true } });
        });
      } else {
        sendToRelay({ type: 'command_response', id, error: { code: -32000, message: 'No active tab' } });
      }
    });
    return true;
  }

  // All other commands — forward to content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) {
      sendToRelay({ type: 'command_response', id, error: { code: -32000, message: 'No active tab' } });
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'execute', command: method, params: params || {} }, (resp) => {
      if (chrome.runtime.lastError) {
        sendToRelay({ type: 'command_response', id, error: { code: -32000, message: chrome.runtime.lastError.message } });
      } else if (resp?.error) {
        sendToRelay({ type: 'command_response', id, error: resp.error });
      } else {
        sendToRelay({ type: 'command_response', id, result: resp });
      }
    });
  });
  return true;
}

// ── Offscreen events ──────────────────────────────────────────────────────────

offscreen.on('connected', () => {
  connected = true;
  broadcastStatus('connected', `Relay ${relayPort} 已连接`);
});

offscreen.on('disconnected', ({ code }) => {
  connected = false;
  broadcastStatus('disconnected', `Relay 已断开 (${code})`);
});

offscreen.on('reconnecting', ({ delay, attempt }) => {
  broadcastStatus('reconnecting', `重连中 ${Math.round(delay / 1000)}s (${attempt})`);
});

offscreen.on('error', ({ message }) => {
  broadcastStatus('error', message);
});

offscreen.on('message', (msg) => {
  if (handleRelayMessage(msg)) return;
  // Broadcast other messages to popup/tabs
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => { if (tab.id) chrome.tabs.sendMessage(tab.id, msg).catch(() => {}); });
  });
  chrome.runtime.sendMessage(msg).catch(() => {});
});

offscreen.on('offscreen_dead', () => {
  connected = false;
  broadcastStatus('disconnected', 'Offscreen 进程终止');
  // Auto-recreate if was connected
  if (autoConnect && relayToken) {
    setTimeout(() => doConnect(), 2000);
  }
});

// ── Connect / Disconnect ──────────────────────────────────────────────────────

async function doConnect() {
  if (!relayToken) {
    broadcastStatus('error', '请先填写 Relay Token');
    return;
  }
  broadcastStatus('connecting', `连接 localhost:${relayPort}...`);
  try {
    await offscreen.connect({ relayPort, token: relayToken, deviceId, deviceName });
  } catch (err) {
    broadcastStatus('error', `连接失败: ${err.message}`);
  }
}

function doDisconnect() {
  autoConnect = false;
  connected = false;
  offscreen.disconnect();
  broadcastStatus('disconnected', '已断开');
}

// ── Listen for messages from popup / content scripts ──────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'connect':
      relayToken = msg.token || relayToken;
      deviceName = msg.deviceName || deviceName;
      autoConnect = true;
      saveConfig({ relayToken: msg.token, deviceName: msg.deviceName, autoConnect: true }).then(doConnect);
      break;
    case 'disconnect':
      doDisconnect();
      break;
    case 'getStatus':
      sendResponse({
        status: connected ? 'connected' : 'disconnected',
        relayPort,
        deviceName,
        deviceId
      });
      break;
    case 'saveConfig':
      saveConfig(msg.config).then(() => sendResponse({ ok: true }));
      return true;
  }
});

// ── Tab Observers — notify gateway of page loads ─────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    chrome.tabs.query({ currentWindow: true }).then(tabs => {
      sendToRelay({
        type: 'event',
        event: 'page.loaded',
        data: { url: tab.url, title: tab.title, tabId, tabCount: tabs.length }
      });
    });
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadConfig().then(() => {
  if (autoConnect) doConnect();
});

chrome.runtime.onInstalled.addListener(() => {
  loadConfig();
});

console.log('[RBC-Relay] Background service worker initialized (offscreen mode)');
