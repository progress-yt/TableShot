const STORAGE_KEY = 'tableshot:connection-draft:v1';
const LEGACY_STORAGE_KEY = 'mysql-capture-connection';

const elements = {
  browserStatusBadge: document.getElementById('browserStatusBadge'),
  connectForm: document.getElementById('connectForm'),
  connectButton: document.getElementById('connectButton'),
  continueLink: document.getElementById('continueLink'),
  existingConnection: document.getElementById('existingConnection'),
  existingConnectionText: document.getElementById('existingConnectionText'),
  formMessage: document.getElementById('formMessage'),
  hostInput: document.getElementById('hostInput'),
  passwordInput: document.getElementById('passwordInput'),
  portInput: document.getElementById('portInput'),
  userInput: document.getElementById('userInput')
};
let connectLock = false;

function loadConnectionDraft() {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    const draft = JSON.parse(current || legacy || '{}');
    if (!current && legacy) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return draft;
  } catch {
    return {};
  }
}

function saveConnectionDraft() {
  try {
    // Only non-secret convenience fields are persisted. Passwords remain memory-only.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        host: elements.hostInput.value.trim(),
        port: elements.portInput.value.trim(),
        user: elements.userInput.value.trim()
      })
    );
  } catch {
    // Storage may be disabled; connecting should still work.
  }
}

function setConnectLock(locked) {
  connectLock = locked;
  elements.connectButton.disabled = locked;
  elements.connectButton.textContent = locked ? '正在连接...' : '连接并进入工作台';
  elements.connectForm.setAttribute('aria-busy', String(locked));
}

function setMessage(message, type = 'neutral') {
  elements.formMessage.textContent = message;
  elements.formMessage.dataset.type = type;
}

function setBrowserBadge(status) {
  const available = status === 'available';
  elements.browserStatusBadge.textContent = available ? '截图引擎可用' : '未检测到 Edge / Chrome';
  elements.browserStatusBadge.className = available ? 'login-badge is-success' : 'login-badge is-warn';
}

function renderExistingConnection(connection) {
  if (!connection) {
    elements.existingConnection.classList.add('is-hidden');
    return;
  }

  elements.existingConnection.classList.remove('is-hidden');
  elements.existingConnectionText.textContent = `${connection.user}@${connection.host}:${connection.port}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `请求失败: ${response.status}`);
  }

  return payload;
}

async function refreshStatus() {
  try {
    const payload = await api('/api/status', { method: 'GET' });
    if (connectLock) return;
    setBrowserBadge(payload.browser);
    renderExistingConnection(payload.connection);
  } catch (error) {
    if (!connectLock) setMessage(error.message, 'error');
  }
}

async function connectDatabase(event) {
  event.preventDefault();
  if (connectLock) return;
  setConnectLock(true);
  saveConnectionDraft();
  setMessage('正在连接数据库...', 'working');

  let connected = false;
  try {
    const payload = await api('/api/connect', {
      method: 'POST',
      body: JSON.stringify({
        host: elements.hostInput.value.trim(),
        port: elements.portInput.value.trim(),
        user: elements.userInput.value.trim(),
        password: elements.passwordInput.value
      })
    });

    setBrowserBadge(payload.browser);
    renderExistingConnection(payload.connection);
    setMessage(`连接成功，MySQL 版本 ${payload.version}，正在进入工作台...`, 'success');
    connected = true;

    window.setTimeout(() => {
      window.location.href = '/app';
    }, 240);
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    if (!connected) setConnectLock(false);
  }
}

function hydrateDraft() {
  const draft = loadConnectionDraft();
  elements.hostInput.value = draft.host || '127.0.0.1';
  elements.portInput.value = draft.port || '3306';
  elements.userInput.value = draft.user || '';
}

function bindEvents() {
  elements.connectForm.addEventListener('submit', connectDatabase);
}

function reveal() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('.reveal').forEach((node, index) => {
    node.style.animationDelay = `${index * 100}ms`;
  });
}

function init() {
  hydrateDraft();
  bindEvents();
  reveal();
  refreshStatus();
}

init();
