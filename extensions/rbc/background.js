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

// ============= Global WebSocket State =============

/** @type {WebSocket|null} Module-level WebSocket (survives as long as SW is alive) */
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pingTimer = null;

/** @type {{ serverUrl: string, token: string, deviceId: string, deviceName: string }} */
let savedConfig = null;

// ============= Connection Manager =============

class RBCConnectionManager {
  constructor() {
    this.sessionId = null;
    this.connected = false;
    this.config = { serverUrl: '', token: '', deviceName: '', deviceId: '', autoConnect: false };
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
    const result = await chrome.storage.local.get(['serverUrl', 'token', 'deviceName', 'autoConnect', 'deviceId']);
    let deviceId = result.deviceId;
    if (!deviceId) { deviceId = crypto.randomUUID(); await chrome.storage.local.set({ deviceId }); }
    this.config = {
      serverUrl: result.serverUrl || '',
      token: result.token || '',
      deviceName: result.deviceName || '',
      deviceId,
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
      deviceName: this.config.deviceName,
      deviceId: this.config.deviceId,
      autoConnect: this.config.autoConnect
    });
  }

  getDeviceId() { return this.config.deviceId || chrome.runtime.id; }

  // ---- Connect / Disconnect ----

  connect() {
    if (!this.config.serverUrl || !this.config.token) {
      this._updateStatus('error', 'Server or token not configured');
      return;
    }
    this._updateStatus('connecting', 'Connecting...');
    savedConfig = {
      serverUrl: this.config.serverUrl,
      token: this.config.token,
      deviceId: this.getDeviceId(),
      deviceName: this.config.deviceName || `Chrome-${this.getDeviceId().slice(0, 8)}`
    };
    reconnectAttempts = 0;
    this._connectWs(savedConfig.serverUrl, savedConfig.token, savedConfig.deviceId, savedConfig.deviceName);
    this._startKeepAliveAlarm();
  }

  disconnect() {
    this._stopPing();
    this._stopKeepAliveAlarm();
    this._clearReconnect();
    if (ws) { try { ws.close(1000, 'disconnect'); } catch {} ws = null; }
    savedConfig = null;
    reconnectAttempts = 9999; // prevent auto-reconnect
    this.sessionId = null;
    this.connected = false;
    this._persistWsState();
    this._updateStatus('disconnected', 'Disconnected');
    this._broadcast({ type: 'status', status: 'disconnected', text: 'Disconnected' });
  }

  // ---- Core WebSocket Management (lives here, not in offscreen!) ----

  _connectWs(serverUrl, token, deviceId, deviceName) {
    // Close existing if any
    if (ws) { try { ws.close(); } catch {} ws = null; }

    // Don't duplicate connecting
    if (ws?.readyState === WebSocket.CONNECTING) return;

    console.log(`[RBC] Connecting to ${serverUrl} ...`);
    let wss;
    try {
      wss = new WebSocket(serverUrl);
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
          deviceId,
          deviceName: deviceName || `Chrome-${deviceId?.slice(0, 8)}`,
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
      // Auto-reconnect if configured
      if (savedConfig && reconnectAttempts < 9999) {
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
        this._updateStatus('error', `Auth failed: ${msg.error}`);
        break;

      case 'pong':
        break; // keepalive response, nothing to do

      case 'event':
        this._handleEvent(msg.event, msg.data);
        break;

      case 'command':
        console.log('[RBC] Received command:', msg.id, msg.method, JSON.stringify(msg.params)?.slice(0,100));
        this._handleCommand(msg.id, msg.method, msg.params, (response) => {
          // SYNC send for command_response - must not use async/await in callback!
          const respData = JSON.stringify({ type: 'command_response', id: msg.id, ...response });
          console.log('[RBC] >>> SYNC sending command_response, id=', msg.id, 'len=', respData.length);
          try {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(respData);
              console.log('[RBC] >>> command_response SENT OK');
            } else {
              console.warn('[RBC] >>> command_response FAILED - ws not ready:', ws?.readyState);
            }
          } catch(err) {
            console.error('[RBC] >>> command_response SEND ERROR:', err.message);
          }
        });
        break;

      case 'command_response': {
        // Resolve pending command promise (for request/response pattern if needed)
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
    console.log('[RBC] send() called, ws=', !!ws, ws?.readyState, 'data.type=', data.type, 'data.id=', data.id || '(none)');
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const json = JSON.stringify(data);
        console.log('[RBC] ws.send() length=', json.length);
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
        this._connectWs(savedConfig.serverUrl, savedConfig.token, savedConfig.deviceId, savedConfig.deviceName);
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
    // Send to popup (if open)
    chrome.runtime.sendMessage(message).catch(() => {});
    // Send to all tabs (for UI updates)
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    });
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
    console.log('[RBC] _handleCommand:', id, method);
    const respondOk = (result) => {
      console.log('[RBC] Command OK:', method, JSON.stringify(result)?.slice(0, 200));
      try { sendResponse({ id, result }); } catch {}
    };
    const respondErr = (msg) => {
      try { sendResponse({ id, error: { code: -32000, message: msg } }); } catch {}
    };

    // Helper: resolve target tab
    const resolveTab = (callback) => {
      console.log('[RBC] resolveTab: params.tabId=', params?.tabId, 'params keys=', Object.keys(params || {}));
      if (params?.tabId) { console.log('[RBC] resolveTab -> using params.tabId'); callback(params.tabId); }
      else {
        console.log('[RBC] resolveTab -> querying active tab');
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          console.log('[RBC] resolveTab query result:', tabs.length, 'tabs', tabs[0]?.id);
          callback(tabs[0]?.id || null);
        });
      }
    };

    // Helper: forward to content script
    const forwardToContent = () => {
      resolveTab((tabId) => {
        if (!tabId) { respondErr('No active tab'); return; }
        console.log('[RBC] Forwarding to tab', tabId, ':', method);
        let done = false;
        const timeout = setTimeout(() => {
          if (!done) { done = true; respondErr(`Timeout: ${method}`); }
        }, 60000);

        chrome.tabs.sendMessage(tabId, { type: 'execute', command: method, params: params || {} }, (resp) => {
          console.log('[RBC] Tab response:', tabId, chrome.runtime.lastError?.message || 'ok', JSON.stringify(resp)?.slice(0, 500));
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
            console.log('[RBC] navigate: reusing existing tab', best.id, best.url);
            doNavigate(best.id);
          } else {
            console.log('[RBC] navigate: no matching tab, creating new');
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
        console.log('[RBC] Executing tabs.list');
        chrome.tabs.query(params?.allWindows ? {} : { currentWindow: true }, (tabs) => {
          console.log('[RBC] tabs.list result:', tabs.length, 'tabs');
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

      case 'file.delete':
        if (!params?.id) { respondErr('id required'); return; }
        chrome.downloads.removeFile(Number(params.id), () => {
          if (chrome.runtime.lastError) respondErr(chrome.runtime.lastError.message);
          else respondOk({ success: true });
        });
        return;

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

      // eval.js: Use chrome.debugger to bypass CSP (shipsage blocks unsafe-eval)
      case 'eval.js':
        resolveTab((tabId) => {
          if (!tabId) { respondErr('No active tab'); return; }
          console.log('[RBC] eval.js via debugger on tab', tabId);
          const numericTabId = parseInt(tabId, 10);
          const script = params?.script || '';
          const doEval = () => {
            chrome.debugger.sendCommand({ tabId: numericTabId }, 'Runtime.evaluate',
              { expression: script, returnByValue: true, awaitPromise: true },
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
          // Attach debugger → evaluate → detach
          chrome.debugger.attach({ tabId: numericTabId }, '1.3', () => {
            if (chrome.runtime.lastError) {
              // Already attached? Just evaluate
              if (chrome.runtime.lastError.message.includes('already attached')) { doEval(); return; }
              respondErr(chrome.runtime.lastError.message); return;
            }
            doEval();
          });
        });
        return;

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
      deviceName: savedConfig.deviceName,
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

restoreState();

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
    } else if (!conn.connected && savedConfig && reconnectAttempts < 9999) {
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
      sendResponse({
        status: conn.status,
        config: conn.config,
        sessionId: conn.sessionId,
        deviceName: conn.config?.deviceName || '',
        deviceId: conn.getDeviceId(),
      });
      break;

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

    case 'content_page_loaded': {
      const srcTabId = sender?.tab?.id;
      conn.send({
        type: 'event', event: 'page.loaded',
        data: { url: message.url, title: message.title, ...(srcTabId ? { tabId: srcTabId } : {}) }
      });
      sendResponse({ received: true });
      break;
    }

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    chrome.tabs.query({ currentWindow: true }).then(tabs => {
      conn.send({
        type: 'event', event: 'page.loaded',
        data: { url: tab.url, title: tab.title, tabId, tabCount: tabs.length }
      });
    });
  }
});

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
  if (delta.state && delta.state.current === 'complete') {
    conn.send({
      type: 'event', event: 'download.complete',
      data: { id: delta.id, filename: delta.filename?.current, state: delta.state.current }
    });
  }
});

console.log('[RBC] Background service worker initialized (direct WebSocket mode)');
