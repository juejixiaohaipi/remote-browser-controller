// background.js — MV3 Service Worker
// WebSocket lives HERE as a module-level global variable (Chrome allows this).
// No offscreen document needed — eliminates all MessagePort fragility.
//
// Architecture:
//   Server ←→ [WebSocket in this file] ←→ background.js
//                                         ├── chrome.tabs API (navigate, tabs list, etc.)
//                                         ├── chrome.tabs.sendMessage → content.js (DOM ops: click, type, snapshot, etc.)
//                                         └── chrome.downloads API
//
// MV3 keepalive: chrome.alarms (every 30s) keeps SW alive.
// State persistence: chrome.storage.session survives SW restarts.

const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 30000;
const ALARM_NAME = 'rbc-keepalive';

// Debug logging: read chrome.storage.local.rbcDebug on startup; toggle from devtools
// or popup via chrome.storage.local.set({ rbcDebug: true }). Warn/error always show.
let DEBUG = false;
try {
  chrome.storage.local.get(['rbcDebug']).then(r => { DEBUG = !!r.rbcDebug; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.rbcDebug) DEBUG = !!changes.rbcDebug.newValue;
  });
} catch {}
const dlog = (...args) => { if (DEBUG) console.log(...args); };

// ============= Global WebSocket State =============

/** @type {WebSocket|null} Module-level WebSocket (survives as long as SW is alive) */
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pingTimer = null;
/** True while we want auto-reconnect on close. Set false on user disconnect or auth_error. */
let shouldReconnect = false;

/** @type {{ serverUrl: string, token: string, deviceId: string, deviceCode: string }} */
let savedConfig = null;

/** Resolves once loadConfig() has finished — gates popup_status etc. */
let initPromise = null;

// ============= Connection Manager =============

class RBCConnectionManager {
  constructor() {
    this.sessionId = null;
    this.connected = false;
    this.config = { serverUrl: '', token: '', deviceId: '', deviceCode: '', autoConnect: false };
    this.status = 'disconnected';
    this.statusText = 'Not connected';
    this._listeners = new Map();
    this._commandHandlers = new Map(); // id -> { resolve, reject, timer }
    this._msgId = 0;
  }

  // ---- Event Emitter ----

  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(cb);
  }

  _emit(event, data) {
    const cbs = this._listeners.get(event) || [];
    for (const cb of cbs) try { cb(data); } catch {}
  }

  // ---- Config ----

  async loadConfig() {
    const result = await chrome.storage.local.get(['serverUrl', 'token', 'deviceId', 'deviceCode', 'autoConnect']);
    // deviceId: user-input UUID for identification
    // deviceCode: auto-generated UUID for this browser instance
    let deviceCode = result.deviceCode;
    if (!deviceCode) { deviceCode = crypto.randomUUID(); await chrome.storage.local.set({ deviceCode }); }
    this.config = {
      serverUrl: result.serverUrl || '',
      token: result.token || '',
      deviceId: result.deviceId || '',
      deviceCode,
      autoConnect: result.autoConnect || false
    };

    // Restore persisted WS state after SW restart
    await this._restoreWsState();

    if (this.config.autoConnect && this.config.serverUrl && this.config.token) {
      // If WS was connected before SW kill, it may still be open or need reconnect
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[RBC] SW restarted, WS still alive — re-authenticating');
        this._doAuth();
      } else {
        this.connect();
      }
    }
  }

  /** Save WS connection state to storage.session so we can detect alive WS after SW restart */
  async _persistWsState() {
    try {
      await chrome.storage.session.set({
        _rbc_ws_connected: !!(ws && ws.readyState === WebSocket.OPEN),
        _rbc_ws_url: this.config.serverUrl,
      });
    } catch {}
  }

  /** Check if WS survived SW restart */
  async _restoreWsState() {
    try {
      const state = await chrome.storage.session.get(['_rbc_ws_connected', '_rbc_ws_url']);
      if (state._rbc_ws_connected && state._rbc_ws_url === this.config.serverUrl) {
        console.log('[RBC] Previous WS may still be alive (state says connected)');
      }
    } catch {}
  }

  async saveConfig(newConfig) {
    Object.assign(this.config, newConfig);
    await chrome.storage.local.set({
      serverUrl: this.config.serverUrl,
      token: this.config.token,
      deviceId: this.config.deviceId,
      deviceCode: this.config.deviceCode,
      autoConnect: this.config.autoConnect
    });
  }

  getDeviceId() { return this.config.deviceId; }
  getDeviceCode() { return this.config.deviceCode; }

  // ---- Connect / Disconnect ----

  connect() {
    if (!this.config.serverUrl || !this.config.token) {
      this._updateStatus('error', 'Server URL and token are required');
      return;
    }
    this._updateStatus('connecting', 'Connecting...');
    savedConfig = {
      serverUrl: this.config.serverUrl,
      token: this.config.token,
      deviceId: this.getDeviceId(),
      deviceCode: this.getDeviceCode()
    };
    reconnectAttempts = 0;
    shouldReconnect = true;
    this._connectWs(savedConfig.serverUrl, savedConfig.token, savedConfig.deviceId, savedConfig.deviceCode);
    this._startKeepAliveAlarm();
  }

  disconnect() {
    this._stopPing();
    this._stopKeepAliveAlarm();
    this._clearReconnect();
    shouldReconnect = false;
    if (ws) { try { ws.close(1000, 'disconnect'); } catch {} ws = null; }
    savedConfig = null;
    this.sessionId = null;
    this.connected = false;
    this._persistWsState();
    this._updateStatus('disconnected', 'Disconnected');
    this._broadcast({ type: 'status', status: 'disconnected', text: 'Disconnected' });
  }

  // ---- Core WebSocket Management (lives here, not in offscreen!) ----

  _connectWs(serverUrl, token, deviceId, deviceCode) {
    // Don't duplicate concurrent connects: check BEFORE nulling the reference
    if (ws?.readyState === WebSocket.CONNECTING) {
      dlog('[RBC] _connectWs: already CONNECTING, skipping');
      return;
    }
    // Close any existing open/closing socket
    if (ws) { try { ws.close(); } catch {} ws = null; }

    console.log(`[RBC] Connecting to ${serverUrl} ...`);
    let wss;
    try {
      // Convert http/https to ws/wss for WebSocket connection
      const wsUrl = serverUrl
        .replace(/^http:\/\//i, 'ws://')
        .replace(/^https:\/\//i, 'wss://');
      wss = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[RBC] WebSocket constructor error:', err.message);
      this._emit('error', { message: err.message });
      this._scheduleReconnect();
      return;
    }

    wss.onopen = () => {
      console.log('[RBC] WebSocket opened');
      reconnectAttempts = 0;
      this._clearReconnect();
      ws = wss;
      this._emit('connected', {});
      this._startPing();

      // Send auth immediately
      if (wss.readyState === WebSocket.OPEN) {
        wss.send(JSON.stringify({
          type: 'auth',
          token,
          deviceId,      // user-input identifier (DB device_sessions.device_id)
          deviceCode,    // auto-generated UUID (DB device_sessions.device_code, UNIQUE)
          browserType: 'chrome',
          tags: ['chrome-extension', 'sw-direct']
        }));
      }
    };

    wss.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleWsMessage(msg);
      } catch (err) {
        console.warn('[RBC] Failed to parse WS message:', err.message);
      }
    };

    wss.onclose = (event) => {
      console.log(`[RBC] WebSocket closed: code=${event.code}`);
      this._stopPing();
      if (ws === wss) ws = null;
      this.connected = false;
      this.sessionId = null;
      this._persistWsState();
      this._emit('disconnected', { code: event.code });
      this._updateStatus('disconnected', `Connection closed (${event.code})`);
      // Auto-reconnect only if user hasn't explicitly disconnected and we haven't hit an auth error
      if (shouldReconnect && savedConfig) {
        this._scheduleReconnect();
      }
    };

    wss.onerror = () => {
      console.error('[RBC] WebSocket error');
      this._emit('error', { message: 'WebSocket error' });
      try { wss.close(); } catch {}
    };

    ws = wss;
  }

  _handleWsMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        this.sessionId = msg.sessionId;
        this.connected = true;
        this._persistWsState();
        this._updateStatus('connected', `Connected (${msg.sessionId?.slice(0, 8)})`);
        this._broadcast({ type: 'connected', sessionId: msg.sessionId });
        break;

      case 'auth_error':
        // Bad credentials — stop auto-reconnect so we don't hammer the server.
        // User must reopen the popup and re-enter token.
        shouldReconnect = false;
        this._clearReconnect();
        this._updateStatus('error', `Auth failed: ${msg.error}`);
        try { ws?.close(1000, 'auth_error'); } catch {}
        break;

      case 'pong':
        break; // keepalive response, nothing to do

      case 'event':
        this._handleEvent(msg.event, msg.data);
        break;

      case 'command':
        // Self-defense: reject commands that arrive before auth_ok.
        if (!this.connected) {
          console.warn('[RBC] Ignoring command before auth:', msg.method);
          try {
            ws?.send(JSON.stringify({
              type: 'command_response', id: msg.id,
              error: { code: -32001, message: 'Not authenticated' }
            }));
          } catch {}
          break;
        }
        dlog('[RBC] Received command:', msg.id, msg.method, JSON.stringify(msg.params)?.slice(0,100));
        this._handleCommand(msg.id, msg.method, msg.params, (response) => {
          // SYNC send for command_response - must not use async/await in callback!
          const respData = JSON.stringify({ type: 'command_response', id: msg.id, ...response });
          dlog('[RBC] >>> SYNC sending command_response, id=', msg.id, 'len=', respData.length);
          try {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(respData);
              dlog('[RBC] >>> command_response SENT OK');
            } else {
              console.warn('[RBC] >>> command_response FAILED - ws not ready:', ws?.readyState);
            }
          } catch(err) {
            console.error('[RBC] >>> command_response SEND ERROR:', err.message);
          }
        });
        break;

      case 'command_response': {
        // Reverse direction only: when WE sent a command via sendCommand() and
        // the server replies. Not used by normal request flow (server-initiated).
        const pending = this._commandHandlers.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this._commandHandlers.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else pending.resolve(msg.result);
        }
        break;
      }

      default:
        // Tab-specific messages (legacy format: "tab_<id>")
        if (msg.type?.startsWith('tab_')) {
          const tabId = msg.type.split('_')[1];
          this._sendToTab(tabId, msg.method, msg.params)
            .then(result => this._send({ type: 'command_response', id: msg.id, result }))
            .catch(err => this._send({ type: 'command_response', id: msg.id, error: { code: -32000, message: err.message } }));
        }
    }
  }

  // ---- Send ----

  /** Send data over WebSocket. Returns true if sent successfully. */
  async send(data) {
    dlog('[RBC] send() called, ws=', !!ws, ws?.readyState, 'data.type=', data.type, 'data.id=', data.id || '(none)');
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const json = JSON.stringify(data);
        dlog('[RBC] ws.send() length=', json.length);
        ws.send(json);
        return true;
      } catch (err) {
        console.warn('[RBC] WS send failed:', err.message);
      }
    } else {
      console.warn('[RBC] WS not ready: ws=', !!ws, 'readyState=', ws?.readyState);
    }
    return false;
  }

  /** Send a command and wait for response (request/response pattern). */
  sendCommand(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = 'cmd-' + (++this._msgId);
      const timer = setTimeout(() => {
        this._commandHandlers.delete(id);
        reject(new Error(`Command ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._commandHandlers.set(id, { resolve, reject, timer });

      this.send({ type: 'command', id, method, params }).then(ok => {
        if (!ok) {
          clearTimeout(timer);
          this._commandHandlers.delete(id);
          reject(new Error('WebSocket not connected'));
        }
      });
    });
  }

  // ---- Reconnection ----

  _scheduleReconnect() {
    this._clearReconnect();
    reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX);
    console.log(`[RBC] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
    this._updateStatus('reconnecting', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
    this._emit('reconnecting', { delay, attempt: reconnectAttempts });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (savedConfig) {
        this._connectWs(savedConfig.serverUrl, savedConfig.token, savedConfig.deviceId, savedConfig.deviceCode);
      }
    }, delay);
  }

  _clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  // ---- Heartbeat (ping/pong via interval) ----

  _startPing() {
    this._stopPing();
    // Note: setInterval in SW is unreliable after ~30s of inactivity.
    // The alarm keepalive (below) prevents SW from being killed.
    // Ping is supplementary — if SW dies, alarm wakes it up and reconnect logic kicks in.
    pingTimer = setInterval(() => {
      if (this.connected && ws && ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' }).catch(() => {});
      }
    }, 25000);
  }

  _stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  // ---- MV3 Keepalive Alarm ----
  // Chrome kills SW after ~30s of inactivity. This alarm fires every 30s
  // to keep the SW alive while connected.

  _startKeepAliveAlarm() {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 }); // 30s
  }

  _stopKeepAliveAlarm() {
    chrome.alarms.clear(ALARM_NAME).catch(() => {});
  }

  // ---- Status & Broadcast ----

  _updateStatus(status, text) {
    this.status = status;
    this.statusText = text;
    this._broadcast({ type: 'status', status, text });
  }

  _broadcast(message) {
    // Only send to popup/extension pages. content.js doesn't subscribe to status
    // messages — broadcasting to every tab was pure overhead (N×sendMessage per
    // status change, all silently dropped).
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  // ---- Event Handling ----

  _handleEvent(event, data) {
    // Events are informational; future: add subscription/waiting
  }

  // ---- Command Handling ----

  /**
   * Handle incoming command from server.
   * Routes: chrome.tabs API commands here, DOM operations forwarded to content script.
   */
  async _handleCommand(id, method, params, sendResponse) {
    dlog('[RBC] _handleCommand:', id, method);
    const respondOk = (result) => {
      dlog('[RBC] Command OK:', method, JSON.stringify(result)?.slice(0, 200));
      try { sendResponse({ id, result }); } catch {}
    };
    const respondErr = (msg) => {
      try { sendResponse({ id, error: { code: -32000, message: msg } }); } catch {}
    };

    // Helper: resolve target tab
    const resolveTab = (callback) => {
      dlog('[RBC] resolveTab: params.tabId=', params?.tabId, 'params keys=', Object.keys(params || {}));
      if (params?.tabId) { dlog('[RBC] resolveTab -> using params.tabId'); callback(params.tabId); }
      else {
        dlog('[RBC] resolveTab -> querying active tab');
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          dlog('[RBC] resolveTab query result:', tabs.length, 'tabs', tabs[0]?.id);
          callback(tabs[0]?.id || null);
        });
      }
    };

    // Helper: forward to content script
    const forwardToContent = () => {
      resolveTab((tabId) => {
        if (!tabId) { respondErr('No active tab'); return; }
        dlog('[RBC] Forwarding to tab', tabId, ':', method);
        let done = false;
        const timeout = setTimeout(() => {
          if (!done) { done = true; respondErr(`Timeout: ${method}`); }
        }, 60000);

        chrome.tabs.sendMessage(tabId, { type: 'execute', command: method, params: params || {} }, (resp) => {
          dlog('[RBC] Tab response:', tabId, chrome.runtime.lastError?.message || 'ok', JSON.stringify(resp)?.slice(0, 500));
          if (done) return;
          done = true;
          clearTimeout(timeout);
          if (chrome.runtime.lastError) { respondErr(chrome.runtime.lastError.message); }
          else if (resp?.error) { try { sendResponse({ id, error: resp.error }); } catch {} }
          else { respondOk(resp); }
        });
      });
    };

    // ── Commands handled by chrome.* APIs (no content script needed) ──
    switch (method) {
      // Navigation — smart: reuse existing tab with same origin if found, otherwise create new tab
      case 'browser.navigate': {
        const targetUrl = params?.url;
        if (!targetUrl) { respondErr('url required'); return; }
        // Reuse: navigate existing matching tab
        const doNavigate = (reuseTabId) => {
          chrome.tabs.update(reuseTabId, { url: targetUrl, active: true }, () => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true, tabId: reuseTabId, reused: true });
          });
        };
        // Fallback: create new tab when no reusable tab found
        const createNewTab = () => {
          chrome.tabs.create({ url: targetUrl, active: true }, (tab) => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true, tabId: tab.id, reused: false });
          });
        };
        // Explicit tabId → always use that tab (no reuse logic)
        if (params?.tabId) {
          chrome.tabs.update(params.tabId, { url: targetUrl, active: true }, () => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true, tabId: params.tabId, reused: false });
          });
          return;
        }
        // Caller explicitly disabled reuse → create new tab directly
        if (params?.reuseTab === false) { createNewTab(); return; }
        // Smart: search for existing same-origin tab to reuse
        const baseOrigin = (() => { try { return new URL(targetUrl).origin; } catch { return null; } })();
        chrome.tabs.query({ url: baseOrigin ? baseOrigin + '/*' : undefined }, (matchingTabs) => {
          if (matchingTabs && matchingTabs.length > 0) {
            const best = matchingTabs.find(t => t.active) || matchingTabs[0];
            dlog('[RBC] navigate: reusing existing tab', best.id, best.url);
            doNavigate(best.id);
          } else {
            dlog('[RBC] navigate: no matching tab, creating new');
            createNewTab();
          }
        });
        return;
      }

      case 'browser.back':
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          chrome.tabs.goBack(tabId, () => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true });
          });
        });
        return;

      case 'browser.forward':
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          chrome.tabs.goForward(tabId, () => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true });
          });
        });
        return;

      case 'browser.reload':
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          chrome.tabs.reload(tabId, { bypassCache: !!params?.bypassCache }, () => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true });
          });
        });
        return;

      case 'browser.close':
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          chrome.tabs.remove(tabId, () => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true, note: 'closed current tab' });
          });
        });
        return;

      // Tabs — smart create: check if URL already open before creating new tab
      case 'tabs.create':
      case 'browser.newTab': {
        const newUrl = params?.url || 'about:blank';
        // Only check reuse if it's a real http(s) URL and caller didn't disable it
        if (params?.reuseTab !== false && /^https?:\/\//i.test(newUrl)) {
          const baseOrigin = (() => { try { return new URL(newUrl).origin; } catch { return null; } })();
          chrome.tabs.query({ url: baseOrigin ? baseOrigin + '/*' : undefined }, (existingTabs) => {
            if (existingTabs && existingTabs.length > 0) {
              const best = existingTabs.find(t => t.active) || existingTabs[0];
              chrome.tabs.update(best.id, { url: newUrl, active: params?.active !== false }, (tab) => {
                if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
                else respondOk({ success: true, tabId: tab.id, reused: true, note: 'reused existing tab' });
              });
            } else {
              chrome.tabs.create({ url: newUrl, active: params?.active !== false }, (tab) => {
                if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
                else respondOk({ success: true, tabId: tab.id, url: tab.url || tab.pendingUrl, reused: false });
              });
            }
          });
        } else {
          chrome.tabs.create({ url: newUrl, active: params?.active !== false }, (tab) => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true, tabId: tab.id, url: tab.url || tab.pendingUrl, reused: false });
          });
        }
        return;
      }

      case 'tabs.close':
      case 'browser.closeTab': {
        const doClose = (tid) => {
          chrome.tabs.remove(tid, () => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ success: true });
          });
        };
        if (params?.tabId) doClose(params.tabId);
        else resolveTab((tid) => { tid ? doClose(tid) : respondErr('No active tab'); });
        return;
      }

      case 'tabs.switch':
      case 'browser.switchTab':
        if (!params?.tabId) { respondErr('tabId required'); return; }
        chrome.tabs.update(params.tabId, { active: true }, (tab) => {
          if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
          else respondOk({ success: true, tabId: tab.id, url: tab.url });
        });
        return;

      case 'tabs.list':
      case 'browser.listTabs':
        dlog('[RBC] Executing tabs.list');
        chrome.tabs.query(params?.allWindows ? {} : { currentWindow: true }, (tabs) => {
          dlog('[RBC] tabs.list result:', tabs.length, 'tabs');
          respondOk({
            tabs: tabs.map(t => ({
              tabId: t.id, url: t.url, title: t.title, active: t.active,
              index: t.index, windowId: t.windowId, pinned: t.pinned, status: t.status
            }))
          });
        });
        return;

      // Downloads
      case 'downloads.list':
        chrome.downloads.search(params?.query || { limit: 50, orderBy: ['-startTime'] }, (items) => {
          if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
          else respondOk({
            downloads: items.map(d => ({
              id: d.id, filename: d.filename, url: d.url, mime: d.mime,
              state: d.state, totalBytes: d.totalBytes, bytesReceived: d.bytesReceived,
              startTime: d.startTime, endTime: d.endTime, exists: d.exists
            }))
          });
        });
        return;

      case 'file.delete': {
        // By default removes the file AND its download-history entry.
        // Pass `{ eraseHistory: false }` to keep the history row.
        if (!params?.id) { respondErr('id required'); return; }
        const dlId = Number(params.id);
        const eraseHistory = params?.eraseHistory !== false;
        chrome.downloads.removeFile(dlId, () => {
          const removeErr = chrome.runtime.lastError?.message;
          if (!eraseHistory) {
            removeErr ? respondErr(removeErr) : respondOk({ success: true, eraseHistory: false });
            return;
          }
          chrome.downloads.erase({ id: dlId }, () => {
            const eraseErr = chrome.runtime.lastError?.message;
            if (removeErr && eraseErr) respondErr(`${removeErr}; erase: ${eraseErr}`);
            else if (removeErr) respondErr(removeErr);
            else if (eraseErr) respondErr(eraseErr);
            else respondOk({ success: true, eraseHistory: true });
          });
        });
        return;
      }

      // Screenshot (via chrome.tabs API)
      case 'page.screenshot':
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
            else respondOk({ dataUrl, format: 'png' });
          });
        });
        return;

      // eval.js / page.evaluate: run via chrome.debugger CDP to bypass strict CSP
      // pages (script-src 'none' etc.) where <script> injection from content.js fails.
      case 'eval.js':
      case 'page.evaluate': {
        const expression = method === 'page.evaluate'
          ? `(${params?.fn})(${(params?.args || []).map(a => JSON.stringify(a)).join(',')})`
          : (params?.script || '');
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          dlog('[RBC]', method, 'via debugger on tab', tabId);
          const numericTabId = parseInt(tabId, 10);
          const doEval = () => {
            chrome.debugger.sendCommand({ tabId: numericTabId }, 'Runtime.evaluate',
              { expression, returnByValue: true, awaitPromise: true },
              (result) => {
                try { chrome.debugger.detach({ tabId: numericTabId }); } catch {}
                if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
                else if (result?.exceptionDetails) {
                  const msg = result.exceptionDetails.exception?.description
                    || result.exceptionDetails.text
                    || JSON.stringify(result.exceptionDetails).slice(0, 200);
                  respondErr(msg);
                }
                else respondOk({ result: result?.result?.value ?? null });
              });
          };
          chrome.debugger.attach({ tabId: numericTabId }, '1.3', () => {
            if (chrome.runtime.lastError) {
              if (chrome.runtime.lastError.message.includes('already attached')) { doEval(); return; }
              respondErr(chrome.runtime.lastError.message); return;
            }
            doEval();
          });
        });
        return;
      }

      default:
        // All other commands → forward to content script (DOM operations)
        forwardToContent();
        return;
    }
  }

  // ---- Content Script Communication ----

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

  // ---- Auth shortcut (called on WS open or SW restart) ----

  _doAuth() {
    if (!savedConfig || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'auth',
      token: savedConfig.token,
      deviceId: savedConfig.deviceId,
      deviceCode: savedConfig.deviceCode,
      browserType: 'chrome',
      tags: ['chrome-extension', 'sw-direct']
    }));
  }
}

// ============= Global Instance =============

const conn = new RBCConnectionManager();

// ============= Initialization =============

async function restoreState() {
  await conn.loadConfig();
}

initPromise = restoreState().catch(err => {
  console.error('[RBC] restoreState failed:', err?.message || err);
});

// ============= Keepalive Port (content.js → background) =============
// content.js opens a persistent port to extend SW lifetime. We must explicitly
// hold the port reference (no-op listener) or Chrome treats it as unhandled.
// Every incoming message bumps SW alive timer.
const _keepalivePorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rbc-tab') return;
  _keepalivePorts.add(port);
  port.onDisconnect.addListener(() => { _keepalivePorts.delete(port); });
  port.onMessage.addListener(() => { /* content may send pong; just keep SW alive */ });
});

// ============= Alarm Handler (MV3 Keepalive) =============
// Fires every 30s while connected — prevents Chrome from killing the SW.

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    // Just touching the WS reference keeps SW alive
    if (conn.connected && ws) {
      // Optionally send a lightweight ping
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
    } else if (!conn.connected && savedConfig && shouldReconnect) {
      // If we should be connected but aren't, trigger reconnect
      conn._scheduleReconnect();
    }

    // If alarm shouldn't be running (disconnected + no auto-connect), stop it
    if (!conn.config.autoConnect || !savedConfig) {
      conn._stopKeepAliveAlarm();
    }
  }
});

// ============= Message Listeners (popup/content script communication) =============

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
      // Wait for initial config load so the popup never sees an empty config
      // during the SW cold-start window.
      (initPromise || Promise.resolve()).then(() => {
        sendResponse({
          status: conn.status,
          statusText: conn.statusText,
          config: conn.config,
          sessionId: conn.sessionId,
          deviceId: conn.getDeviceId(),
          deviceCode: conn.getDeviceCode(),
        });
      });
      return true;

    case 'popup_save_config':
      conn.saveConfig(message.config).then(() => sendResponse({ success: true }));
      return true;

    case 'popup_get_default_token':
      sendResponse({ token: conn.config.token });
      break;

    // Messages FROM content script TO server
    case 'content_dialog': {
      const srcTabId = sender?.tab?.id;
      conn.send({
        type: 'event', event: 'dialog.opened',
        data: { dialogType: message.dialogType, message: message.message, ...(srcTabId ? { tabId: srcTabId } : {}) }
      });
      sendResponse({ received: true });
      break;
    }

    // content_page_loaded removed: page.loaded is emitted by chrome.tabs.onUpdated below,
    // content.js never sent this message.

    case 'content_screenshot': {
      const srcTabId = sender?.tab?.id;
      conn.send({
        type: 'event', event: 'screenshot.captured',
        data: { screenshot: message.screenshot, ...(srcTabId ? { tabId: srcTabId } : {}) }
      });
      sendResponse({ received: true });
      break;
    }

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

// Per-tab dedup: avoid firing page.loaded twice when both `status=complete`
// and `url` change events land for the same URL (common on SPA route changes).
const _lastLoadedUrl = new Map(); // tabId -> url

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Fire on: (a) full load complete, or (b) URL change (catches SPA pushState).
  const urlChanged = !!changeInfo.url;
  const loadComplete = changeInfo.status === 'complete';
  if (!urlChanged && !loadComplete) return;
  if (!tab.url || !tab.url.startsWith('http')) return;
  if (_lastLoadedUrl.get(tabId) === tab.url) return;
  _lastLoadedUrl.set(tabId, tab.url);

  chrome.tabs.query({ currentWindow: true }).then(tabs => {
    conn.send({
      type: 'event', event: 'page.loaded',
      data: { url: tab.url, title: tab.title, tabId, tabCount: tabs.length }
    });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => { _lastLoadedUrl.delete(tabId); });

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url && tab.url.startsWith('http')) {
      conn.send({
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
  conn.send({
    type: 'event', event: 'download.started',
    data: {
      id: downloadItem.id, filename: downloadItem.filename, url: downloadItem.url,
      mimeType: downloadItem.mime, state: downloadItem.state, startedAt: downloadItem.startTime
    }
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const state = delta.state.current;
  if (state === 'complete') {
    conn.send({
      type: 'event', event: 'download.complete',
      data: { id: delta.id, filename: delta.filename?.current, state }
    });
  } else if (state === 'interrupted') {
    conn.send({
      type: 'event', event: 'download.interrupted',
      data: { id: delta.id, filename: delta.filename?.current, state, error: delta.error?.current }
    });
  }
});

console.log('[RBC] Background service worker initialized (direct WebSocket mode)');
