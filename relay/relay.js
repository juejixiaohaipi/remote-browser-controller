#!/usr/bin/env node
/**
 * RBC Relay — bridges Chrome extension (localhost) to remote BAP Gateway
 *
 * Chrome Extension  ──ws──►  localhost:18792  ──ws──►  Remote BAP Gateway
 *                       (relay.exe)                 (remote:3000)
 *
 * Usage:
 *   node relay.js                            # reads .env
 *   node relay.js --gateway ws://...         # CLI overrides .env
 *   node relay.js --device-id my-pc          # CLI overrides .env
 */

const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) return;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  });
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg.startsWith('--')) {
    acc[arg.slice(2)] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
  }
  return acc;
}, {});

const LISTEN_PORT  = parseInt(args.port || process.env.RBC_RELAY_PORT || process.env.RELAY_PORT || '18792');
const LISTEN_HOST  = args.host || process.env.RBC_RELAY_HOST || '127.0.0.1';
const GATEWAY_URL  = args.gateway || process.env.RBC_GATEWAY_URL || '';
const DEVICE_ID    = args['device-id'] || process.env.RBC_DEVICE_ID || 'rbc-relay';
const DEVICE_NAME  = args['device-name'] || process.env.RBC_DEVICE_NAME || 'RBC-Relay';
const TOKEN        = args.token || process.env.RBC_RELAY_TOKEN || '';
const LOG_PREFIX   = `[relay:${DEVICE_ID}]`;

// ── Validate required config ────────────────────────────────────────────────
if (!GATEWAY_URL) {
  console.error('ERROR: Gateway URL is required. Set RBC_GATEWAY_URL in .env or use --gateway ws://host:port/ws');
  process.exit(1);
}
if (!TOKEN) {
  console.error('ERROR: Token is required. Set RBC_RELAY_TOKEN in .env or use --token <token>');
  process.exit(1);
}

// ── Gateway reconnection config ─────────────────────────────────────────────
const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 60000;
let reconnectAttempts = 0;
let reconnectTimer = null;

// ── Message queue for when gateway is disconnected ───────────────────────────
const MSG_QUEUE_MAX = 100;
const messageQueue = [];

let relayConnection = null; // WebSocket to remote BAP Gateway
let extensionConnection = null; // WebSocket from Chrome extension
let extensionAuth = null; // Auth info from extension's auth message

// ── Logging ──────────────────────────────────────────────────────────────────
function log(...args) {
  console.log(LOG_PREFIX, new Date().toISOString(), ...args);
}
function logError(...args) {
  console.error(LOG_PREFIX, new Date().toISOString(), 'ERROR:', ...args);
}

// ── Determine effective device identity for gateway auth ─────────────────────
function getGatewayAuth() {
  // Prefer extension's deviceId/deviceName if available
  if (extensionAuth && extensionAuth.deviceId) {
    return {
      deviceId: extensionAuth.deviceId,
      deviceName: extensionAuth.deviceName || extensionAuth.deviceId,
      browserType: 'chrome',
      tags: ['chrome-extension', 'via-relay']
    };
  }
  // Fall back to relay's own identity
  return {
    deviceId: DEVICE_ID,
    deviceName: DEVICE_NAME,
    browserType: 'relay',
    tags: ['rbc-relay', 'cdp-bridge']
  };
}

// ── Connect to remote BAP Gateway ───────────────────────────────────────────
function connectToGateway() {
  if (relayConnection && relayConnection.readyState === WebSocket.OPEN) return;

  log(`Connecting to BAP Gateway: ${GATEWAY_URL} (attempt ${reconnectAttempts + 1})`);
  try {
    relayConnection = new WebSocket(GATEWAY_URL);
  } catch (err) {
    logError('Failed to create WebSocket:', err.message);
    scheduleGatewayReconnect();
    return;
  }

  relayConnection.on('open', () => {
    reconnectAttempts = 0;
    log('Connected to BAP Gateway, authenticating...');
    const auth = getGatewayAuth();
    log(`Gateway auth as deviceId=${auth.deviceId} deviceName=${auth.deviceName}`);
    relayConnection.send(JSON.stringify({
      type: 'auth',
      token: TOKEN,
      ...auth
    }));
    // Flush queued messages
    flushMessageQueue();
  });

  relayConnection.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      log('← from gateway:', msg.type);
      // Forward to Chrome extension if connected
      if (extensionConnection && extensionConnection.readyState === WebSocket.OPEN) {
        extensionConnection.send(data.toString());
      }
    } catch (e) {
      logError('Failed to parse gateway message:', e.message);
    }
  });

  relayConnection.on('close', (code, reason) => {
    log(`Gateway connection closed: code=${code} reason=${reason || 'none'}`);
    relayConnection = null;
    scheduleGatewayReconnect();
  });

  relayConnection.on('error', (err) => {
    logError('Gateway connection error:', err.message);
    relayConnection?.close();
  });
}

function scheduleGatewayReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempts), RECONNECT_MAX);
  reconnectAttempts++;
  log(`Reconnecting to gateway in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToGateway();
  }, delay);
}

function flushMessageQueue() {
  if (!relayConnection || relayConnection.readyState !== WebSocket.OPEN) return;
  const count = messageQueue.length;
  if (count === 0) return;
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    relayConnection.send(msg);
  }
  log(`Flushed ${count} queued messages`);
}

function sendToGateway(data) {
  if (relayConnection && relayConnection.readyState === WebSocket.OPEN) {
    relayConnection.send(data);
  } else {
    // Queue message for when gateway reconnects
    messageQueue.push(data);
    if (messageQueue.length > MSG_QUEUE_MAX) {
      messageQueue.shift(); // Drop oldest
    }
    if (relayConnection) {
      log(`Gateway not connected, queued message (${messageQueue.length}/${MSG_QUEUE_MAX})`);
    }
  }
}

// Re-authenticate to gateway with new extension auth info
function reauthToGateway() {
  if (!relayConnection || relayConnection.readyState !== WebSocket.OPEN) return;
  const auth = getGatewayAuth();
  log(`Re-auth gateway as deviceId=${auth.deviceId} deviceName=${auth.deviceName}`);
  relayConnection.send(JSON.stringify({
    type: 'auth',
    token: TOKEN,
    ...auth
  }));
}

// ── HTTP health check ────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      relayVersion: '1.1.0',
      extensionConnected: extensionConnection !== null && extensionConnection.readyState === WebSocket.OPEN,
      gateway: relayConnection?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      queuedMessages: messageQueue.length,
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── Extension heartbeat — detect dead connections early ──────────────────────
const EXT_PING_INTERVAL = 25000;
let extPingTimer = null;

function startExtPing(ws) {
  stopExtPing();
  extPingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping(); // WebSocket-level ping, auto-replied with pong by client
    } else {
      stopExtPing();
    }
  }, EXT_PING_INTERVAL);
}

function stopExtPing() {
  if (extPingTimer) { clearInterval(extPingTimer); extPingTimer = null; }
}

// ── WebSocket server (receives connections from Chrome extension) ────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const query = url.parse(req.url, true).query;
  const clientIp = req.socket.remoteAddress;

  // Validate token — accept from query param or wait for auth message
  const queryToken = query.token;
  if (queryToken && queryToken !== TOKEN) {
    log(`Rejected extension from ${clientIp}: invalid token`);
    ws.close(1008, 'Invalid token');
    return;
  }

  // Allow new connection to replace stale old connection
  if (extensionConnection && extensionConnection.readyState === WebSocket.OPEN) {
    log('New extension connection replacing existing one');
    extensionConnection.close(1000, 'Replaced by new connection');
  }

  log(`Extension connected from ${clientIp}`);
  extensionConnection = ws;
  let authenticated = !!queryToken; // Pre-authenticated if token in query

  // Ensure gateway connection is alive
  if (!relayConnection || relayConnection.readyState !== WebSocket.OPEN) {
    connectToGateway();
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Validate auth message if not yet authenticated
      if (!authenticated) {
        if (msg.type === 'auth') {
          if (msg.token !== TOKEN) {
            log('Extension auth failed: invalid token');
            ws.close(1008, 'Invalid token');
            return;
          }
          authenticated = true;
          // Store extension's auth info for gateway authentication
          extensionAuth = {
            deviceId: msg.deviceId,
            deviceName: msg.deviceName,
            browserType: msg.browserType
          };
          log(`Extension authenticated: deviceId=${extensionAuth.deviceId} deviceName=${extensionAuth.deviceName}`);
          // Re-auth to gateway with extension's identity (don't forward original auth)
          reauthToGateway();
          return;
        } else {
          log('Extension not authenticated, rejecting message');
          ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
          return;
        }
      }

      // Don't forward auth messages — relay handles gateway auth itself
      if (msg.type === 'auth') {
        log('Extension re-auth, updating identity');
        extensionAuth = {
          deviceId: msg.deviceId,
          deviceName: msg.deviceName,
          browserType: msg.browserType
        };
        reauthToGateway();
        return;
      }

      log('← from extension:', msg.type);
      // Forward to BAP Gateway
      sendToGateway(data.toString());
    } catch (e) {
      logError('Failed to parse extension message:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    log(`Extension disconnected: code=${code} reason=${reason || 'none'}`);
    if (extensionConnection === ws) {
      extensionConnection = null;
      extensionAuth = null;
      stopExtPing();
    }
  });

  ws.on('error', (err) => {
    logError('Extension connection error:', err.message);
    if (extensionConnection === ws) extensionConnection = null;
  });

  // Start server-side ping to detect dead connections
  startExtPing(ws);

  // Send ready signal to extension
  ws.send(JSON.stringify({ type: 'relay_ready', relayVersion: '1.1.0' }));
});

// ── Start ───────────────────────────────────────────────────────────────────
httpServer.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`RBC Relay listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  log(`Gateway target: ${GATEWAY_URL}`);
  log(`Device: ${DEVICE_NAME} (${DEVICE_ID})`);
  connectToGateway();
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down...');
  httpServer.close();
  relayConnection?.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down...');
  httpServer.close();
  relayConnection?.close();
  process.exit(0);
});
