/**
 * RBC Relay — Chrome Extension
 * Connects to local relay (relay.exe), which bridges to remote BAP Gateway.
 * Much simpler than direct connection — relay handles reconnection & keep-alive.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let relayWs = null;
let relayToken = null;
let deviceName = 'RBC-Relay';
let deviceId = null;
let relayPort = 18792;
let autoConnect = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 30000;
const MAX_RECONNECT_ATTEMPTS = 15;

// ── Load config from storage ──────────────────────────────────────────────────
async function loadConfig() {
  const result = await chrome.storage.local.get(['relayPort', 'relayToken', 'deviceName', 'autoConnect', 'deviceId']);
  relayPort = result.relayPort || 18792;
  relayToken = result.relayToken || '';
  deviceName = result.deviceName || 'RBC-Relay';
  autoConnect = result.autoConnect ?? false;

  // Persistent deviceId — generate once, reuse forever
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

// ── Command routing: forward gateway commands to content script ───────────────
function handleGatewayMessage(msg) {
  if (msg.type !== 'command') return false;

  const { id, method, params } = msg;

  // browser.navigate — handle locally via Chrome tab API
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

  // browser.snapshot — forward to content script
  if (method === 'browser.snapshot') {
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

  // All other commands — forward to active tab's content script
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

function sendToRelay(data) {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify(data));
  }
}

// ── Connect to local relay ────────────────────────────────────────────────────
function connect() {
  if (!relayToken) {
    broadcastStatus('error', '请先填写 Relay Token');
    return;
  }
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return;

  broadcastStatus('connecting', `连接 localhost:${relayPort}...`);

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try {
    // Connect without token in URL — authenticate via message after connect
    relayWs = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  } catch (err) {
    broadcastStatus('error', `连接失败: ${err.message}`);
    scheduleReconnect();
    return;
  }

  relayWs.onopen = () => {
    reconnectAttempts = 0;
    broadcastStatus('connected', `Relay ${relayPort} 已连接`);
    // Authenticate so relay knows our identity
    relayWs.send(JSON.stringify({
      type: 'auth',
      token: relayToken,
      deviceId,
      deviceName,
      browserType: 'chrome',
      tags: ['rbc-relay']
    }));
  };

  relayWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      // Try to handle as gateway command first
      if (handleGatewayMessage(msg)) return;
      // Otherwise broadcast to tabs and popup (status updates, events, etc.)
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => { if (tab.id) chrome.tabs.sendMessage(tab.id, msg).catch(() => {}); });
      });
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (err) {
      console.warn('[RBC-Relay] Failed to parse message:', err.message);
    }
  };

  relayWs.onclose = (event) => {
    relayWs = null;
    broadcastStatus('disconnected', `Relay 已断开 (${event.code})`);
    scheduleReconnect();
  };

  relayWs.onerror = () => {
    relayWs?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (!autoConnect) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    broadcastStatus('error', `已达最大重连次数 (${MAX_RECONNECT_ATTEMPTS})`);
    return;
  }
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempts), RECONNECT_MAX);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  if (relayWs) { relayWs.close(1000, 'User disconnect'); relayWs = null; }
  broadcastStatus('disconnected', '已断开');
}

// ── Listen for messages from popup / content scripts ──────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'connect':
      relayToken = msg.token || relayToken;
      deviceName = msg.deviceName || deviceName;
      autoConnect = true;
      reconnectAttempts = 0;
      saveConfig({ relayToken: msg.token, deviceName: msg.deviceName, autoConnect: true }).then(connect);
      break;
    case 'disconnect':
      autoConnect = false;
      disconnect();
      break;
    case 'getStatus':
      sendResponse({
        status: relayWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
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
    sendToRelay({
      type: 'event',
      event: 'page.loaded',
      data: { url: tab.url, title: tab.title, tabId }
    });
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadConfig().then(() => {
  if (autoConnect) connect();
});

chrome.runtime.onInstalled.addListener(() => {
  loadConfig();
});
