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
    //
    // Self-heals when the content script is missing — common after the
    // extension is reloaded (existing tabs lose their content scripts and the
    // declarative content_scripts entry only re-injects on next navigation).
    // On the first "Receiving end does not exist" we use chrome.scripting to
    // inject content.js into the tab and retry the send once.
    const forwardToContent = () => {
      resolveTab((tabId) => {
        if (!tabId) { respondErr('No active tab'); return; }
        const numericTabId = parseInt(tabId, 10);
        dlog('[RBC] Forwarding to tab', tabId, ':', method);

        const send = (alreadyInjected) => {
          let done = false;
          const timeout = setTimeout(() => {
            if (!done) { done = true; respondErr(`Timeout: ${method}`); }
          }, 60000);

          chrome.tabs.sendMessage(numericTabId, { type: 'execute', command: method, params: params || {} }, (resp) => {
            dlog('[RBC] Tab response:', tabId, chrome.runtime.lastError?.message || 'ok', JSON.stringify(resp)?.slice(0, 500));
            if (done) return;
            const lastErrMsg = chrome.runtime.lastError?.message || '';

            // Auto-inject the content script on missing-receiver and retry once.
            // Don't auto-inject for restricted URLs (chrome://, web store) —
            // that injection would just fail again with a clearer error.
            if (!alreadyInjected && lastErrMsg.includes('Receiving end does not exist')) {
              done = true;
              clearTimeout(timeout);
              dlog('[RBC] No content script in tab; injecting and retrying:', method);
              chrome.scripting.executeScript(
                { target: { tabId: numericTabId }, files: ['content.js'] },
                () => {
                  if (chrome.runtime.lastError) {
                    respondErr(`content script injection failed: ${chrome.runtime.lastError.message}` +
                      ` (tab may be on a restricted URL like chrome:// or the Chrome Web Store)`);
                    return;
                  }
                  send(true);
                }
              );
              return;
            }

            done = true;
            clearTimeout(timeout);
            if (chrome.runtime.lastError) { respondErr(lastErrMsg); }
            else if (resp?.error) { try { sendResponse({ id, error: resp.error }); } catch {} }
            else { respondOk(resp); }
          });
        };
        send(false);
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

      // page.ax_tree: full accessibility tree via CDP. Returns interactive
      // nodes with computed role / name (from the browser's a11y engine —
      // more accurate than DOM heuristics) plus a CSS selector hint built
      // from the backend DOM node's attributes.
      case 'page.ax_tree': {
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          const numericTabId = parseInt(tabId, 10);
          const sendCDP = (cmd, args) => new Promise((resolve, reject) => {
            chrome.debugger.sendCommand({ tabId: numericTabId }, cmd, args || {}, (r) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(r);
            });
          });
          const INTERACTIVE = new Set([
            'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
            'searchbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
            'tab', 'switch', 'slider', 'spinbutton', 'option',
          ]);
          const buildSelector = (node) => {
            if (!node || !node.attributes) return null;
            const attrs = {};
            for (let i = 0; i < node.attributes.length; i += 2) {
              attrs[node.attributes[i]] = node.attributes[i + 1];
            }
            const tag = (node.localName || '').toLowerCase();
            // id, data-testid, name, aria-label — in priority order
            if (attrs.id && /^[a-zA-Z_][\w-]*$/.test(attrs.id)) return '#' + attrs.id;
            if (attrs.id) return `[id="${attrs.id.replace(/"/g, '\\"')}"]`;
            if (attrs['data-testid']) return `[data-testid="${attrs['data-testid'].replace(/"/g, '\\"')}"]`;
            if (attrs.name && tag) return `${tag}[name="${attrs.name.replace(/"/g, '\\"')}"]`;
            if (attrs['aria-label']) return `[aria-label="${attrs['aria-label'].replace(/"/g, '\\"')}"]`;
            // type-based hints for inputs
            if (tag === 'input' && attrs.type) return `input[type="${attrs.type}"]`;
            return null;
          };
          const getValue = (v) => v && typeof v === 'object' && 'value' in v ? v.value : v;
          const propMap = (props) => {
            const m = {};
            for (const p of props || []) m[p.name] = getValue(p.value);
            return m;
          };
          const doFetch = async () => {
            try {
              await sendCDP('Accessibility.enable', {}).catch(() => {});
              await sendCDP('DOM.enable', {}).catch(() => {});
              const ax = await sendCDP('Accessibility.getFullAXTree', {});
              const nodes = ax?.nodes || [];

              // First pass: filter interactive non-ignored nodes.
              const candidates = [];
              for (const n of nodes) {
                if (n.ignored) continue;
                const role = getValue(n.role);
                if (!INTERACTIVE.has(role)) continue;
                candidates.push(n);
              }

              // Second pass: resolve DOM details for each — done in parallel
              // but capped to avoid blasting the protocol.
              const out = [];
              const CONCURRENCY = 8;
              for (let i = 0; i < candidates.length; i += CONCURRENCY) {
                const slice = candidates.slice(i, i + CONCURRENCY);
                const resolved = await Promise.all(slice.map(async (n) => {
                  const role = getValue(n.role);
                  const name = (getValue(n.name) || '').toString().slice(0, 120);
                  const value = (getValue(n.value) || '').toString().slice(0, 80);
                  const desc = (getValue(n.description) || '').toString().slice(0, 80);
                  const props = propMap(n.properties);
                  let selector = null, tag = null;
                  if (n.backendDOMNodeId) {
                    try {
                      const r = await sendCDP('DOM.describeNode', { backendNodeId: n.backendDOMNodeId });
                      tag = (r?.node?.localName || '').toLowerCase();
                      selector = buildSelector(r?.node);
                    } catch {}
                  }
                  return {
                    nodeId: n.nodeId,
                    backendNodeId: n.backendDOMNodeId,
                    role,
                    name,
                    value,
                    description: desc,
                    tag,
                    selector,
                    disabled: !!props.disabled,
                    focused: !!props.focused,
                    checked: props.checked,
                    expanded: props.expanded,
                  };
                }));
                out.push(...resolved);
              }
              respondOk({ count: out.length, nodes: out });
            } catch (e) {
              respondErr(e.message);
            } finally {
              try { chrome.debugger.detach({ tabId: numericTabId }); } catch {}
            }
          };
          chrome.debugger.attach({ tabId: numericTabId }, '1.3', () => {
            if (chrome.runtime.lastError) {
              if (chrome.runtime.lastError.message.includes('already attached')) { doFetch(); return; }
              respondErr(chrome.runtime.lastError.message); return;
            }
            doFetch();
          });
        });
        return;
      }

      // element.trusted_click: synthesize a real user-gesture click via CDP.
      // Required to trigger Chrome's password-manager autofill (which gates on
      // event.isTrusted). Looks up the element's center via Runtime.evaluate,
      // then dispatches mousePressed + mouseReleased through Input.dispatchMouseEvent.
      case 'element.trusted_click': {
        const selector = params?.selector;
        if (!selector) { respondErr('selector required'); return; }
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          const numericTabId = parseInt(tabId, 10);
          const sendCDP = (cmd, args) => new Promise((resolve, reject) => {
            chrome.debugger.sendCommand({ tabId: numericTabId }, cmd, args, (r) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(r);
            });
          });
          const doClick = async () => {
            try {
              // 1) Resolve coordinates of the element (scroll into view first) and
              //    introspect its state so callers can distinguish "clicked" from
              //    "fired into the void on a disabled / hidden / obscured target".
              //
              //    Coord-based CDP clicks are different from DOM .click():
              //    - pointer-events:none on a target makes the click pass THROUGH
              //      to whatever is underneath at (cx, cy) — must reject.
              //    - off-screen coords land outside the viewport; the dispatched
              //      mouse event hits nothing useful — must reject.
              //    - opacity:0 is fine; opacity does not affect hit-testing.
              const expr = `(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return { found: false };
                try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                const zeroSize = r.width === 0 || r.height === 0;
                const hidden = cs.visibility === 'hidden';
                const pointerNone = cs.pointerEvents === 'none';
                const visible = !zeroSize && !hidden;
                const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
                const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                const inViewport = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight;
                let obscuredBy = null;
                if (visible && inViewport) {
                  const top = document.elementFromPoint(cx, cy);
                  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
                    const tt = (top.tagName || '').toLowerCase();
                    const id = top.id ? '#' + top.id : '';
                    const cls = (typeof top.className === 'string' && top.className)
                      ? '.' + top.className.split(/\\s+/).filter(Boolean).slice(0, 2).join('.')
                      : '';
                    obscuredBy = tt + id + cls;
                  }
                }
                return {
                  found: true,
                  x: cx, y: cy,
                  tag: (el.tagName || '').toLowerCase(),
                  disabled, zeroSize, hidden, pointerNone, visible, inViewport, obscuredBy,
                  bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
                };
              })()`;
              const evalRes = await sendCDP('Runtime.evaluate', { expression: expr, returnByValue: true });
              const v = evalRes?.result?.value;
              if (!v?.found) { respondErr(`Element not found: ${selector}`); return; }
              const { x, y, tag, disabled, zeroSize, hidden, pointerNone, visible, inViewport, obscuredBy, bbox } = v;
              const baseInfo = { found: true, tag, disabled, visible, inViewport, obscuredBy, bbox, x, y };
              // Refuse to dispatch when the click would be meaningless or land
              // on the wrong element — better to surface the failure than fire
              // mouse events into the void.
              if (disabled)    { respondOk({ ...baseInfo, success: false, reason: 'element is disabled' }); return; }
              if (zeroSize)    { respondOk({ ...baseInfo, success: false, reason: 'element has zero size (display:none / detached / collapsed parent)' }); return; }
              if (hidden)      { respondOk({ ...baseInfo, success: false, reason: 'element has visibility:hidden' }); return; }
              if (pointerNone) { respondOk({ ...baseInfo, success: false, reason: 'element has pointer-events:none — CDP click would pass through to a different element' }); return; }
              if (!inViewport) { respondOk({ ...baseInfo, success: false, reason: 'element still off-screen after scrollIntoView (parent may be overflow:hidden / position-fixed in unreachable spot)' }); return; }

              // 2) Install click probe in the page so we can answer: did the
              //    event actually reach our target? was it isTrusted? did the
              //    page react afterwards?
              //    Probe state is parked on window.__rbcClickProbe so the read
              //    step (which runs after CDP mouse events) can pick it up.
              const installExpr = `(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return false;
                const probe = {
                  fired: false, isTrusted: null, defaultPrevented: false, targetTag: null,
                  urlBefore: location.href,
                  htmlSizeBefore: (document.body && document.body.innerHTML ? document.body.innerHTML.length : 0),
                  scrollBefore: window.scrollY,
                };
                const handler = (e) => {
                  if (e.composedPath().indexOf(el) !== -1) {
                    probe.fired = true;
                    probe.isTrusted = e.isTrusted;
                    probe.defaultPrevented = e.defaultPrevented;
                    probe.targetTag = (e.target && e.target.tagName ? e.target.tagName.toLowerCase() : null);
                  }
                };
                window.__rbcClickProbe = probe;
                window.__rbcClickProbeHandler = handler;
                window.addEventListener('click', handler, { capture: true });
                return true;
              })()`;
              await sendCDP('Runtime.evaluate', { expression: installExpr, returnByValue: true });

              // 3) Trusted click — Chrome treats CDP-dispatched mouse events as user gestures.
              await sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved',    x, y });
              await sendCDP('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1 });
              await sendCDP('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

              // 4) Wait briefly for async page reactions and read the probe.
              //    If navigation occurred, the probe object is gone — that is
              //    itself a strong signal that the click had an effect.
              const readExpr = `(async () => {
                await new Promise(r => setTimeout(r, 400));
                const p = window.__rbcClickProbe;
                if (!p) {
                  return { dispatched: true, navigated: true, urlAfter: location.href, note: 'probe missing — page navigated, fresh execution context' };
                }
                const urlChanged = location.href !== p.urlBefore;
                const htmlSizeAfter = (document.body && document.body.innerHTML ? document.body.innerHTML.length : 0);
                const htmlChanged = Math.abs(htmlSizeAfter - p.htmlSizeBefore) > 100;
                const scrollChanged = window.scrollY !== p.scrollBefore;
                try { window.removeEventListener('click', window.__rbcClickProbeHandler, true); } catch (e) {}
                delete window.__rbcClickProbe;
                delete window.__rbcClickProbeHandler;
                return {
                  dispatched: p.fired === true,
                  isTrusted: p.isTrusted,
                  defaultPrevented: p.defaultPrevented === true,
                  targetTag: p.targetTag,
                  urlChanged, htmlChanged, scrollChanged,
                  pageReacted: urlChanged || htmlChanged || scrollChanged,
                  urlAfter: location.href,
                };
              })()`;
              let probe = {};
              try {
                const probeRes = await sendCDP('Runtime.evaluate', { expression: readExpr, awaitPromise: true, returnByValue: true });
                probe = probeRes?.result?.value || {};
              } catch (e) {
                // Eval can fail if the page navigated and the execution
                // context was destroyed. That itself signals a working click.
                probe = { dispatched: true, navigated: true, note: 'read-probe eval failed — likely navigation: ' + e.message };
              }
              respondOk({ ...baseInfo, success: true, ...probe });
            } catch (e) {
              respondErr(e.message);
            } finally {
              try { chrome.debugger.detach({ tabId: numericTabId }); } catch {}
            }
          };
          chrome.debugger.attach({ tabId: numericTabId }, '1.3', () => {
            if (chrome.runtime.lastError) {
              if (chrome.runtime.lastError.message.includes('already attached')) { doClick(); return; }
              respondErr(chrome.runtime.lastError.message); return;
            }
            doClick();
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
