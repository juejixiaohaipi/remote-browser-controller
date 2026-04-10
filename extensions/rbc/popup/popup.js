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
  deviceName:   $('deviceName'),
  autoConnect:  $('autoConnect'),
  connectBtn:  $('connectBtn'),
  disconnectBtn: $('disconnectBtn'),
  sessionInfo:  $('sessionInfo'),
  sessId:       $('sessId'),
  sessDevice:   $('sessDevice'),
  sessDeviceId: $('sessDeviceId'),
  sessToken:   $('sessToken'),
  logContainer: $('logContainer'),
};

// ─── Config ───────────────────────────────────────────────────────────────

async function loadConfig() {
  const r = await chrome.storage.local.get(['serverUrl', 'token', 'deviceName', 'autoConnect', 'connectionStatus', 'statusText']);
  el.serverUrl.value = r.serverUrl || '';
  el.token.value = r.token || '';
  el.deviceName.value = r.deviceName || '';
  el.autoConnect.checked = r.autoConnect || false;
  if (r.connectionStatus) updateStatus(r.connectionStatus, r.statusText || '');
  if (r.token) el.sessToken.textContent = r.token.slice(0, 8) + '...';
}

async function saveConfig() {
  const config = {
    serverUrl: el.serverUrl.value,
    token: el.token.value,
    deviceName: el.deviceName.value,
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      // Download
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `screenshot-${Date.now()}.png`;
      a.click();
      addLog('Screenshot saved');
    }
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
  entry.innerHTML = `<span class="time">${time}</span>${msg}`;
  el.logContainer.insertBefore(entry, el.logContainer.firstChild);
  while (el.logContainer.children.length > 50) el.logContainer.removeChild(el.logContainer.lastChild);
}

// ─── Actions ────────────────────────────────────────────────────────────

async function connect() {
  if (!el.serverUrl.value || !el.token.value) { addLog('Please fill in server URL and token', 'error'); return; }
  await saveConfig();
  addLog(`连接 ${el.serverUrl.value}...`);
  chrome.runtime.sendMessage({ type: 'popup_connect' }, resp => {
    addLog(resp?.success ? 'Connection request sent' : 'Connection failed', resp?.success ? 'info' : 'error');
  });
}

function disconnect() {
  chrome.runtime.sendMessage({ type: 'popup_disconnect' }, resp => {
    if (resp?.success) { addLog('Disconnected'); updateStatus('disconnected', 'Disconnected'); }
  });
}

// ─── Events from background ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'popup_update') return;
  if (msg.status) updateStatus(msg.status, msg.text);
  if (msg.sessionId) el.sessId.textContent = msg.sessionId;
  if (msg.deviceName) el.sessDevice.textContent = msg.deviceName;
  if (msg.deviceId) el.sessDeviceId.textContent = msg.deviceId;
  if (msg.text) addLog(msg.text);
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
el.deviceName.addEventListener('change', saveConfig);
el.autoConnect.addEventListener('change', saveConfig);

loadConfig().then(async () => {
  await refreshTabInfo();

  chrome.runtime.sendMessage({ type: 'popup_status' }, (status) => {
    if (status) {
      if (status.sessionId) el.sessId.textContent = status.sessionId;
      if (status.deviceName) el.sessDevice.textContent = status.deviceName;
      if (status.deviceId) el.sessDeviceId.textContent = status.deviceId;
      if (status.status) {
        updateStatus(status.status, status.statusText);
        addLog(`Status: ${status.statusText || status.status}`);
      }
    }
  });
  addLog('Config loaded');
});
