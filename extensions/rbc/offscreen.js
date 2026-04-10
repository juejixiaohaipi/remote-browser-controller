// offscreen.js — WebSocket lives here, survives service worker kills
// Background SW talks to this via MessagePort (chrome.runtime.connect)

let ws = null;
let reconnectAttempts = 0;
let bgPort = null;
const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 15000;

function sendToBg(type, data = {}) {
  if (!bgPort) return;
  try {
    bgPort.postMessage({ source: 'offscreen', type, ...data });
  } catch {}
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX);
  sendToBg('reconnecting', { delay, attempt: reconnectAttempts });
  setTimeout(() => {
    if (savedConfig) connect.apply(null, savedConfig);
  }, delay);
}

function connect(serverUrl, token, deviceId, deviceName) {
  if (ws) { ws.close(); ws = null; }
  let wss;
  try {
    wss = new WebSocket(serverUrl);
  } catch (err) {
    sendToBg('error', { message: err.message });
    scheduleReconnect();
    return;
  }
  ws = wss;

  ws.onopen = () => {
    reconnectAttempts = 0;
    sendToBg('connected', {});
    ws.send(JSON.stringify({
      type: 'auth', token, deviceId,
      deviceName: deviceName || `Chrome-${deviceId?.slice(0, 8)}`,
      browserType: 'chrome', tags: ['chrome-extension', 'offscreen']
    }));
  };

  wss.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      sendToBg('message', { msg });
    } catch (err) {
      console.warn('[Offscreen] Failed to parse WebSocket message:', err.message, event.data?.slice?.(0, 200));
    }
  };

  wss.onclose = (event) => {
    sendToBg('disconnected', { code: event.code });
    ws = null;
    scheduleReconnect();
  };

  wss.onerror = () => {
    sendToBg('error', { message: 'WebSocket error' });
    ws?.close();
  };
}

let savedConfig = null;

// Accept connection from background via chrome.runtime.connect
chrome.runtime.onConnect.addListener((port) => {
  console.log('[Offscreen] Port connected', port.name);
  bgPort = port;

  port.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'offscreen') return;
    switch (msg.action) {
      case 'start':
        savedConfig = [msg.serverUrl, msg.token, msg.deviceId, msg.deviceName];
        reconnectAttempts = 0;
        connect(msg.serverUrl, msg.token, msg.deviceId, msg.deviceName);
        break;
      case 'stop':
        reconnectAttempts = 9999;
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
    // WebSocket stays alive — background will reconnect the port if needed
  });
});

console.log('[Offscreen] Initialized, waiting for background port...');
