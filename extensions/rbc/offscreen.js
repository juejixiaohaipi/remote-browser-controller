// offscreen.js — WebSocket lives here, survives service worker kills
// Background SW talks to this via MessagePort (chrome.runtime.connect)
// IMPORTANT: This is the ONLY place that manages the WebSocket lifecycle.
// Background should NOT have its own reconnect loop.

let ws = null;
let reconnectAttempts = 0;
let bgPort = null;
let pingTimer = null;
let reconnectTimer = null;
let savedConfig = null;

const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 15000;
const PING_INTERVAL = 25000;

// Message queue for when bgPort is disconnected (SW killed by Chrome MV3)
let pendingMessages = [];

function sendToBg(type, data = {}) {
  // Try to deliver via existing port
  if (bgPort) {
    try {
      bgPort.postMessage({ source: 'offscreen', type, ...data });
      return true;
    } catch { /* port dead */ }
  }
  // No port available — queue non-trivial messages (skip pings)
  if (type !== 'connected' && type !== 'disconnected' && type !== 'error' && type !== 'reconnecting') {
    console.warn(`[Offscreen] bgPort missing, queuing message type=${type}`);
    pendingMessages.push({ source: 'offscreen', type, ...data });
    // Try to wake up SW by connecting
    tryReconnectPort();
  }
  return false;
}

/** Flush all queued messages once port reconnects */
function flushPending() {
  while (pendingMessages.length && bgPort) {
    const msg = pendingMessages.shift();
    try { bgPort.postMessage(msg); } catch {
      // Port died again — put back and stop
      pendingMessages.unshift(msg);
      break;
    }
  }
  if (pendingMessages.length > 0) {
    console.warn(`[Offscreen] ${pendingMessages.length} messages still pending (port dead)`);
  }
}

/** Attempt to reconnect MessagePort to background SW */
function tryReconnectPort() {
  if (bgPort) return; // already connected
  try {
    const port = chrome.runtime.connect(chrome.runtime.id, { name: 'rbc-offscreen' });
    // Note: this will trigger chrome.runtime.onConnect in the NEW SW instance,
    // which sets up its listeners and eventually becomes our new bgPort.
    // We don't set bgPort here — that happens in the onConnect handler below.
    console.log('[Offscreen] Attempting port reconnect to revive SW...');
  } catch (err) {
    console.error('[Offscreen] Port reconnect failed:', err.message);
  }
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

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
  cancelReconnect();
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX);
  sendToBg('reconnecting', { delay, attempt: reconnectAttempts });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (savedConfig) connect.apply(null, savedConfig);
  }, delay);
}

/** Report current connection state to background (used after SW restart) */
function reportStatus() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendToBg('connected', {});
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    sendToBg('reconnecting', { delay: 0, attempt: reconnectAttempts });
  } else {
    sendToBg('disconnected', { code: 0 });
  }
}

function connect(serverUrl, token, deviceId, deviceName) {
  // If already connected, just report status (handles SW restart case)
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('[Offscreen] connect: already connected, reporting status');
    reportStatus();
    return;
  }
  // If already connecting, wait for it
  if (ws && ws.readyState === WebSocket.CONNECTING) {
    console.log('[Offscreen] connect: already connecting, skipping');
    return;
  }
  if (ws) { ws.close(); ws = null; }

  let wss;
  try {
    wss = new WebSocket(serverUrl);
  } catch (err) {
    sendToBg('error', { message: err.message });
    scheduleReconnect();
    return;
  }

  wss.onopen = () => {
    reconnectAttempts = 0;
    cancelReconnect();
    sendToBg('connected', {});
    startPing();
    if (wss.readyState === WebSocket.OPEN && wss === ws) {
      wss.send(JSON.stringify({
        type: 'auth', token, deviceId,
        deviceName: deviceName || `Chrome-${deviceId?.slice(0, 8)}`,
        browserType: 'chrome', tags: ['chrome-extension', 'offscreen']
      }));
    }
  };

  wss.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      // If this is a command and SW is dead, wait for port reconnect instead of rejecting immediately
      if (msg.type === 'command' && !bgPort) {
        console.warn(`[Offscreen] Command ${msg.method} received but SW not connected — queuing and waiting for port`);
        // Queue for later delivery once port reconnects
        sendToBg('message', { msg });
        // Wait up to 15s for port to reconnect, then return error
        const waitForPort = (retries = 30) => {
          if (bgPort) {
            console.log(`[Offscreen] Port recovered, delivering queued command ${msg.method}`);
            sendToBg('message', { msg });
            return;
          }
          if (retries <= 0) {
            console.error(`[Offscreen] Command ${msg.method} timed out waiting for port`);
            try {
              wss.send(JSON.stringify({
                type: 'command_response',
                id: msg.id,
                error: { code: -32002, message: 'Service Worker not connected — timed out waiting for recovery' }
              }));
            } catch {}
            return;
          }
          setTimeout(() => waitForPort(retries - 1), 500);
        };
        waitForPort();
        return;
      }
      sendToBg('message', { msg });
    } catch (err) {
      console.warn('[Offscreen] Failed to parse message:', err.message);
    }
  };

  wss.onclose = (event) => {
    stopPing();
    sendToBg('disconnected', { code: event.code });
    if (wss === ws) ws = null;
    // Only auto-reconnect if we have config and weren't explicitly stopped
    if (savedConfig && reconnectAttempts < 9999) {
      scheduleReconnect();
    }
  };

  wss.onerror = () => {
    sendToBg('error', { message: 'WebSocket error' });
    wss?.close();
  };

  ws = wss;
}

// Accept connection from background via chrome.runtime.connect
chrome.runtime.onConnect.addListener((port) => {
  console.log('[Offscreen] Port connected:', port.name);
  bgPort = port;

  // Flush any messages that were queued while SW was dead
  if (pendingMessages.length > 0) {
    console.log(`[Offscreen] Flushing ${pendingMessages.length} queued messages`);
    flushPending();
  }

  port.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'offscreen') return;
    switch (msg.action) {
      case 'start':
        savedConfig = [msg.serverUrl, msg.token, msg.deviceId, msg.deviceName];
        reconnectAttempts = 0;
        cancelReconnect();
        connect(msg.serverUrl, msg.token, msg.deviceId, msg.deviceName);
        break;
      case 'stop':
        savedConfig = null; // prevent auto-reconnect
        reconnectAttempts = 9999;
        cancelReconnect();
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
      case 'get_state':
        // Background can query full state (used after SW restart)
        port.postMessage({
          id: msg._id,
          connected: ws?.readyState === WebSocket.OPEN,
          hasConfig: !!savedConfig,
          reconnectAttempts,
        });
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[Offscreen] Port disconnected (SW killed?) — commands will be queued until SW revives');
    bgPort = null;
    // Attempt to revive SW after short delay (MV3: chrome.runtime.connect wakes SW)
    setTimeout(() => { if (!bgPort && ws) tryReconnectPort(); }, 1000);
  });
});

console.log('[Offscreen] Initialized, waiting for background port...');
