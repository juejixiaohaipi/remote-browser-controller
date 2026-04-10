// offscreen.js — WebSocket lives here, survives Service Worker kills
// Background SW communicates via chrome.runtime.connect (MessagePort)

let ws = null;
let reconnectAttempts = 0;
let bgPort = null;
let savedConfig = null;
let pingTimer = null;

const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 30000;
const PING_INTERVAL = 25000; // keep WebSocket alive

function sendToBg(type, data = {}) {
  if (!bgPort) return;
  try {
    bgPort.postMessage({ source: 'offscreen', type, ...data });
  } catch {}
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_INTERVAL);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX);
  sendToBg('reconnecting', { delay, attempt: reconnectAttempts });
  setTimeout(() => {
    if (savedConfig) connect(savedConfig.relayPort, savedConfig.token, savedConfig.deviceId, savedConfig.deviceName);
  }, delay);
}

function connect(relayPort, token, deviceId, deviceName) {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }
  if (ws) { ws.close(); ws = null; }

  let wss;
  try {
    wss = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  } catch (err) {
    sendToBg('error', { message: err.message });
    scheduleReconnect();
    return;
  }

  wss.onopen = () => {
    reconnectAttempts = 0;
    sendToBg('connected', {});
    startPing();
    // Authenticate with relay
    if (wss.readyState === WebSocket.OPEN && wss === ws) {
      wss.send(JSON.stringify({
        type: 'auth',
        token,
        deviceId,
        deviceName: deviceName || `Chrome-${deviceId?.slice(0, 8)}`,
        browserType: 'chrome',
        tags: ['rbc-relay', 'offscreen']
      }));
    }
  };

  wss.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      sendToBg('message', { msg });
    } catch (err) {
      console.warn('[Offscreen] Failed to parse message:', err.message);
    }
  };

  wss.onclose = (event) => {
    stopPing();
    sendToBg('disconnected', { code: event.code });
    if (wss === ws) ws = null;
    scheduleReconnect();
  };

  wss.onerror = () => {
    sendToBg('error', { message: 'WebSocket error' });
    wss?.close();
  };

  ws = wss;
}

// Accept connection from background via chrome.runtime.connect
chrome.runtime.onConnect.addListener((port) => {
  console.log('[Offscreen] Port connected', port.name);
  bgPort = port;

  port.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'offscreen') return;
    switch (msg.action) {
      case 'start':
        savedConfig = { relayPort: msg.relayPort, token: msg.token, deviceId: msg.deviceId, deviceName: msg.deviceName };
        reconnectAttempts = 0;
        connect(msg.relayPort, msg.token, msg.deviceId, msg.deviceName);
        break;
      case 'stop':
        reconnectAttempts = 9999;
        stopPing();
        ws?.close();
        break;
      case 'send':
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg.data));
          port.postMessage({ id: msg._id, ok: true });
        } else {
          port.postMessage({ id: msg._id, ok: false, error: 'Not connected' });
        }
        break;
      case 'status':
        port.postMessage({ id: msg._id, connected: ws?.readyState === WebSocket.OPEN });
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[Offscreen] Port disconnected');
    bgPort = null;
    // WebSocket stays alive — background will reconnect the port
  });
});

console.log('[Offscreen] Initialized, waiting for background port...');
