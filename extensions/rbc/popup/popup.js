// Remote Browser Controller - Popup Script
const $ = id => document.getElementById(id);

const el = {
  statusDot:    $('statusDot'),
  statusText:   $('statusText'),
  statusBadge:  $('statusBadge'),
  currentUrl:   $('currentUrl'),
  tabCount:     $('tabCount'),
  qsScreenshot: $('qsScreenshot'),
  qsNewTab:    $('qsNewTab'),
  qsRefresh:    $('qsRefresh'),
  serverUrl:    $('serverUrl'),
  token:        $('token'),
  deviceId:     $('deviceId'),
  autoConnect:  $('autoConnect'),
  connectBtn:   $('connectBtn'),
  disconnectBtn: $('disconnectBtn'),
  sessionInfo:  $('sessionInfo'),
  sessId:         $('sessId'),
  sessDeviceId:   $('sessDeviceId'),
  sessDeviceCode: $('sessDeviceCode'),
  sessToken:      $('sessToken'),
  logContainer: $('logContainer'),
};

// ─── Config ───────────────────────────────────────────────────────────────

async function loadConfig() {
  const r = await chrome.storage.local.get(['serverUrl', 'token', 'deviceId', 'autoConnect']);
  el.serverUrl.value = r.serverUrl || '';
  el.token.value = r.token || '';
  el.deviceId.value = r.deviceId || '';
  el.autoConnect.checked = r.autoConnect || false;
  if (r.token) el.sessToken.textContent = r.token.slice(0, 8) + '...';
  // Current status is fetched from background via popup_status (see init below)
}

async function saveConfig() {
  const config = {
    serverUrl: el.serverUrl.value,
    token: el.token.value,
    deviceId: el.deviceId.value,
    autoConnect: el.autoConnect.checked,
  };
  await chrome.storage.local.set(config);
  chrome.runtime.sendMessage({ type: 'popup_save_config', config });
}

// ─── Status UI ───────────────────────────────────────────────────────────

function updateStatus(status, text) {
  el.statusDot.className = 'status-dot ' + status;
  el.statusText.textContent = text || getDefaultText(status);

  const labels = { connected: 'Online', disconnected: 'Offline', connecting: 'Connecting', reconnecting: 'Reconnecting', error: 'Error' };
  el.statusBadge.textContent = labels[status] || '--';

  const isConnected = status === 'connected';
  el.connectBtn.disabled = isConnected || !el.serverUrl.value || !el.token.value;
  el.disconnectBtn.disabled = !isConnected;

  // Enable quick actions when connected
  el.qsScreenshot.disabled = !isConnected;
  el.qsNewTab.disabled = !isConnected;
  el.qsRefresh.disabled = !isConnected;

  if (isConnected) {
    el.sessionInfo.style.display = 'block';
    el.sessToken.textContent = (el.token.value || '?').slice(0, 8) + '...';
  } else {
    el.sessionInfo.style.display = 'none';
  }
}

function getDefaultText(status) {
  const map = { connected: 'Connected', disconnected: 'Not connected', connecting: 'Connecting...', reconnecting: 'Reconnecting...', error: 'Connection error' };
  return map[status] || '未知';
}

// ─── Tab Info ────────────────────────────────────────────────────────────

async function refreshTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const url = tab.url || tab.pendingUrl || '';
      const display = url.replace(/^https?:\/\//, '').slice(0, 40);
      el.currentUrl.textContent = display || '(New tab)';
      el.currentUrl.title = url;
    }
    const tabs = await chrome.tabs.query({ currentWindow: true });
    el.tabCount.textContent = tabs.length;
  } catch { /* ignore */ }
}

// ─── Quick Actions ──────────────────────────────────────────────────────

async function doScreenshot() {
  addLog('Taking screenshot...');
  try {
    // Use the same code path as server-triggered screenshots: ask background
    // to capture, which keeps a single source of truth for the capture logic.
    const dataUrl = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'capture_visible_tab' }, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resp ? resolve(resp) : reject(new Error('No active tab'));
      });
    });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `screenshot-${Date.now()}.png`;
    a.click();
    addLog('Screenshot saved');
  } catch (e) {
    addLog('Screenshot failed: ' + e.message, 'error');
  }
}

async function doNewTab() {
  try {
    await chrome.tabs.create({ active: true });
    addLog('New tab opened');
    setTimeout(refreshTabInfo, 500);
  } catch (e) {
    addLog('新建标签失败', 'error');
  }
}

async function doRefreshStatus() {
  chrome.runtime.sendMessage({ type: 'popup_status' }, (status) => {
    if (status) {
      if (status.status) updateStatus(status.status, status.statusText);
      if (status.sessionId) el.sessId.textContent = status.sessionId;
      addLog('Status refreshed');
    }
  });
  await refreshTabInfo();
}

// ─── Log ────────────────────────────────────────────────────────────────

function addLog(msg, level = 'info') {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = time;
  entry.appendChild(timeSpan);
  // textContent avoids HTML injection from server/page-provided error messages
  entry.appendChild(document.createTextNode(String(msg)));
  el.logContainer.insertBefore(entry, el.logContainer.firstChild);
  while (el.logContainer.children.length > 50) el.logContainer.removeChild(el.logContainer.lastChild);
}

// ─── Actions ────────────────────────────────────────────────────────────

async function connect() {
  if (!el.serverUrl.value || !el.token.value) { addLog('Please fill in server URL and token', 'error'); return; }
  await saveConfig();
  addLog(`连接 ${el.serverUrl.value}...`);

  // Send message and wait for async response via Promise.
  //
  // CRITICAL: In Chrome MV3, chrome.runtime.sendMessage() returns false when the
  // Service Worker is suspended/not running. However, the message IS queued and
  // the callback WILL fire once the SW starts up and registers its listener.
  // So we must ALWAYS wait for the callback — never reject on false return value.
  // Retrying would only restart the SW each time (making things worse).
  try {
    const resp = await new Promise((resolve, reject) => {
      let settled = false;

      // sendMessage returns false when SW is cold — IGNORE this, still wait for callback
      chrome.runtime.sendMessage({ type: 'popup_connect' }, (resp) => {
        if (settled) return; // already timed out or errored
        settled = true;
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });

      // Give the SW enough time to cold-start (~15s should be more than enough)
      setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('Connection timeout (15s) — Service Worker did not respond')); }
      }, 15000);
    });

    if (resp?.success) {
      addLog('连接成功，等待认证...');
    } else {
      addLog('连接失败: ' + (resp?.error || '未知错误'), 'error');
    }
  } catch (err) {
    addLog('连接异常: ' + err.message, 'error');
    if (err.message.includes('Extension context')) {
      addLog('Extension context失效，请在 chrome://extensions 重新加载插件', 'error');
    }
  }
}

function disconnect() {
  chrome.runtime.sendMessage({ type: 'popup_disconnect' }, resp => {
    if (resp?.success) { addLog('Disconnected'); updateStatus('disconnected', 'Disconnected'); }
  });
}

// ─── Events from background ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  // Background broadcasts multiple message types — handle all of them
  const statusTypes = ['popup_update', 'popup_status', 'status', 'connected', 'disconnected', 'reconnecting', 'error'];
  if (!statusTypes.includes(msg.type)) return;

  if (msg.status) updateStatus(msg.status, msg.text || msg.statusText);
  if (msg.type === 'connected') { updateStatus('connected', 'Connected'); addLog('连接成功！'); }
  if (msg.type === 'disconnected') { updateStatus('disconnected', 'Disconnected'); addLog(msg.text || 'Disconnected'); }
  if (msg.type === 'reconnecting') { updateStatus('reconnecting', `Reconnecting... (${msg.attempt})`); addLog(`重连中... (${msg.attempt})`, 'warn'); }
  if (msg.sessionId) el.sessId.textContent = msg.sessionId;
  if (msg.config?.deviceId) el.sessDeviceId.textContent = msg.config.deviceId.slice(0, 8);
  if (msg.config?.deviceCode) el.sessDeviceCode.textContent = msg.config.deviceCode.slice(0, 8);
  if (msg.text || msg.statusText) addLog(msg.text || msg.statusText);
  if (msg.url) { el.currentUrl.textContent = msg.url.slice(0, 40); el.currentUrl.title = msg.url; }
});

// ─── Init ──────────────────────────────────────────────────────────────

el.connectBtn.addEventListener('click', connect);
el.disconnectBtn.addEventListener('click', disconnect);
el.qsScreenshot.addEventListener('click', doScreenshot);
el.qsNewTab.addEventListener('click', doNewTab);
el.qsRefresh.addEventListener('click', doRefreshStatus);
el.serverUrl.addEventListener('change', saveConfig);
el.token.addEventListener('change', saveConfig);
el.deviceId.addEventListener('change', saveConfig);
el.autoConnect.addEventListener('change', saveConfig);

loadConfig().then(async () => {
  await refreshTabInfo();

  chrome.runtime.sendMessage({ type: 'popup_status' }, (status) => {
    if (status) {
      if (status.sessionId) el.sessId.textContent = status.sessionId;
      if (status.config?.deviceId) el.sessDeviceId.textContent = status.config.deviceId.slice(0, 8);
      if (status.config?.deviceCode) el.sessDeviceCode.textContent = status.config.deviceCode.slice(0, 8);
      if (status.status) {
        updateStatus(status.status, status.statusText);
        addLog(`Status: ${status.statusText || status.status}`);
      }
    }
  });
  addLog('Config loaded');
});
