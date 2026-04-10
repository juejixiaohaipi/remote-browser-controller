/**
 * RBC Relay — Chrome Extension
 * Connects to local relay (relay.exe), which bridges to remote BAP Gateway.
 * Much simpler than direct connection — relay handles reconnection & keep-alive.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let relayWs = null;
let relayToken = null;
let deviceName = 'RBC-Relay';
let relayPort = 18792;
let autoConnect = false;
let reconnectTimer = null;

// ── Load config from storage ──────────────────────────────────────────────────
async function loadConfig() {
  const result = await chrome.storage.local.get(['relayPort', 'relayToken', 'deviceName', 'autoConnect']);
  relayPort = result.relayPort || 18792;
  relayToken = result.relayToken || '';
  deviceName = result.deviceName || 'RBC-Relay';
  autoConnect = result.autoConnect ?? false;
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
    relayWs = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${encodeURIComponent(relayToken)}`);
  } catch (err) {
    broadcastStatus('error', `连接失败: ${err.message}`);
    scheduleReconnect();
    return;
  }

  relayWs.onopen = () => {
    broadcastStatus('connected', `Relay ${relayPort} 已连接`);
    // Authenticate so relay knows our identity
    relayWs.send(JSON.stringify({
      type: 'auth',
      token: relayToken,
      deviceId: `rbc-relay-${Date.now()}`,
      deviceName,
      browserType: 'chrome',
      tags: ['rbc-relay']
    }));
  };

  relayWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      // Forward to all tabs
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => { if (tab.id) chrome.tabs.sendMessage(tab.id, msg).catch(() => {}); });
      });
      // Also broadcast to popup
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {}
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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (autoConnect) connect();
  }, 3000);
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
      saveConfig({ relayToken: msg.token, deviceName: msg.deviceName, autoConnect: true }).then(connect);
      break;
    case 'disconnect':
      autoConnect = false;
      disconnect();
      break;
    case 'getStatus':
      sendResponse({ status: relayWs ? 'connected' : 'disconnected', relayPort, deviceName });
      break;
    case 'saveConfig':
      saveConfig(msg.config).then(() => sendResponse({ ok: true }));
      return true;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadConfig().then(() => {
  if (autoConnect) connect();
});

chrome.runtime.onInstalled.addListener(() => {
  loadConfig();
});
