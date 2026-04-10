// Popup logic for RBC Relay

const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const tokenInput = document.getElementById('token');
const portInput = document.getElementById('port');
const nameInput = document.getElementById('name');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const btnSave = document.getElementById('btn-save');

function setStatus(status, text) {
  statusBar.className = 'status-bar ' + status;
  statusText.textContent = text;
}

// Load current config and status
async function init() {
  const cfg = await chrome.storage.local.get(['relayPort', 'relayToken', 'deviceName']);
  if (cfg.relayPort) portInput.value = cfg.relayPort;
  if (cfg.relayToken) tokenInput.value = cfg.relayToken;
  if (cfg.deviceName) nameInput.value = cfg.deviceName;

  // Get current connection status
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getStatus' });
    if (resp?.status === 'connected') {
      setStatus('connected', `已连接 localhost:${resp.relayPort || 18792}`);
    } else {
      setStatus('disconnected', '未连接');
    }
  } catch {
    setStatus('disconnected', '未连接');
  }

  // Listen for status updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'status') {
      setStatus(msg.status, msg.text);
    }
  });
}

btnConnect.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const port = parseInt(portInput.value) || 18792;
  const name = nameInput.value.trim() || 'RBC-Relay';
  if (!token) { alert('请输入 Relay Token'); return; }
  setStatus('connecting', `连接 localhost:${port}...`);
  chrome.runtime.sendMessage({ type: 'connect', token, deviceName: name });
});

btnDisconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  setStatus('disconnected', '已断开');
});

btnSave.addEventListener('click', async () => {
  const port = parseInt(portInput.value) || 18792;
  const name = nameInput.value.trim() || 'RBC-Relay';
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({ relayPort: port, relayToken: token, deviceName: name });
  btnSave.textContent = '已保存!';
  setTimeout(() => { btnSave.textContent = '保存设置'; }, 1500);
});

init();
