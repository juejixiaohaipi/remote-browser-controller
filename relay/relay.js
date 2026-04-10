#!/usr/bin/env node
/**
 * RBC Relay — bridges Chrome extension (localhost) to remote BAP Gateway
 *
 * Chrome Extension  ──ws──►  localhost:18792  ──ws──►  Remote BAP Gateway
 *                       (relay.exe)                 (192.168.0.100:3000)
 *
 * Usage:
 *   node relay.js                          # reads .env
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

const LISTEN_PORT  = parseInt(args.port || '18792');
const GATEWAY_URL  = args.gateway || 'ws://192.168.0.100:3000/ws';
const DEVICE_ID    = args['device-id'] || 'rbc-relay';
const DEVICE_NAME  = args['device-name'] || 'RBC-Relay';
const TOKEN        = args.token || process.env.RBC_RELAY_TOKEN || 'XERJS7O4y_NF4fzyAlalN3i0udAd6wuT';
const LOG_PREFIX   = `[relay:${DEVICE_ID}]`;

let relayConnection = null; // WebSocket to remote BAP Gateway
let extensionConnection = null; // WebSocket from Chrome extension

// ── Logging ──────────────────────────────────────────────────────────────────
function log(...args) {
  console.log(LOG_PREFIX, new Date().toISOString(), ...args);
}
function logError(...args) {
  console.error(LOG_PREFIX, new Date().toISOString(), 'ERROR:', ...args);
}

// ── Connect to remote BAP Gateway ───────────────────────────────────────────
function connectToGateway() {
  if (relayConnection && relayConnection.readyState === WebSocket.OPEN) return;

  log(`Connecting to BAP Gateway: ${GATEWAY_URL}`);
  relayConnection = new WebSocket(GATEWAY_URL);

  relayConnection.on('open', () => {
    log('Connected to BAP Gateway, authenticating...');
    // Authenticate as a browser/relay device
    relayConnection.send(JSON.stringify({
      type: 'auth',
      token: TOKEN,
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      browserType: 'relay',
      tags: ['rbc-relay', 'cdp-bridge']
    }));
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
    // Reconnect after 3 seconds
    setTimeout(connectToGateway, 3000);
  });

  relayConnection.on('error', (err) => {
    logError('Gateway connection error:', err.message);
  });
}

// ── Local HTTP server (health check) ───────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      gateway: relayConnection ? 'connected' : 'disconnected',
      extension: extensionConnection ? 'connected' : 'disconnected',
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── WebSocket server (receives connections from Chrome extension) ────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const query = url.parse(req.url, true).query;
  log(`Extension connected from ${req.socket.remoteAddress}, token valid: ${!!query.token}`);

  if (extensionConnection && extensionConnection.readyState === WebSocket.OPEN) {
    log('Extension already connected, rejecting new connection');
    ws.close(1008, 'Relay already has an active extension connection');
    return;
  }

  extensionConnection = ws;

  // Ensure gateway connection is alive
  if (!relayConnection || relayConnection.readyState !== WebSocket.OPEN) {
    connectToGateway();
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      log('← from extension:', msg.type);
      // Forward to BAP Gateway
      if (relayConnection && relayConnection.readyState === WebSocket.OPEN) {
        relayConnection.send(data.toString());
      } else {
        log('Gateway not connected, queuing...');
      }
    } catch (e) {
      logError('Failed to parse extension message:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    log(`Extension disconnected: code=${code} reason=${reason || 'none'}`);
    extensionConnection = null;
  });

  ws.on('error', (err) => {
    logError('Extension connection error:', err.message);
    extensionConnection = null;
  });

  // Send ready signal to extension
  ws.send(JSON.stringify({ type: 'relay_ready', relayVersion: '1.0.0' }));
});

// ── Start ───────────────────────────────────────────────────────────────────
httpServer.listen(LISTEN_PORT, '127.0.0.1', () => {
  log(`RBC Relay listening on http://127.0.0.1:${LISTEN_PORT}`);
  log(`Gateway target: ${GATEWAY_URL}`);
  log(`Device: ${DEVICE_NAME} (${DEVICE_ID})`);
  connectToGateway();
});

process.on('SIGINT', () => {
  log('Shutting down...');
  if (relayConnection) relayConnection.close();
  if (extensionConnection) extensionConnection.close();
  httpServer.close();
  process.exit(0);
});
