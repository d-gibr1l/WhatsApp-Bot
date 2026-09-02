import API from './api.js';
import { showToast, switchTab, toggleTheme, initTheme } from './ui.js';

let isConnected = false;
let statusInterval, qrInterval;
let groupsData = [];
let selectedGroupId = null;

const featureLabels = {
  antilink: { name: 'Anti-Link', desc: 'Automatically delete WhatsApp group invite links.' },
  antidelete: { name: 'Anti-Delete', desc: 'Forward deleted messages to moderators.' },
  chatbot: { name: 'AI Chatbot', desc: 'Enable Gemini/OpenAI auto-replies.' },
  welcome: { name: 'Welcome Message', desc: 'Send a greeting when a user joins.' },
  nsfw: { name: 'NSFW Content', desc: 'Allow mature API commands.' },
  bangroup: { name: 'Mute Bot', desc: 'Disable the bot entirely in this group.' },
  allowed: { name: 'Force Allow', desc: 'Allow the bot in this group even when in Private/Self mode.' }
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  setupEventListeners();
  setupAuthForms();
  authGate();
});

async function authGate() {
  let mode = 'login';
  try {
    const state = await API.fetchAuthState();
    mode = state.mode || 'login';
  } catch (e) {
    mode = 'login';
  }

  if (mode === 'authed') {
    hideAuthOverlay();
    boot();
  } else if (mode === 'setup') {
    showAuthOverlay('setup');
  } else {
    showAuthOverlay('login');
  }
}

function showAuthOverlay(which) {
  const overlay = document.getElementById('auth-overlay');
  const loginForm = document.getElementById('login-form');
  const setupForm = document.getElementById('setup-form');
  if (!overlay) return;
  overlay.style.display = 'flex';
  loginForm.style.display = which === 'login' ? 'flex' : 'none';
  setupForm.style.display = which === 'setup' ? 'flex' : 'none';
  const focusEl = document.getElementById(which === 'setup' ? 'setup-password' : 'login-password');
  if (focusEl) focusEl.focus();
}

function hideAuthOverlay() {
  const overlay = document.getElementById('auth-overlay');
  if (overlay) overlay.style.display = 'none';
}

function setupAuthForms() {
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pwInput = document.getElementById('login-password');
      const errorEl = document.getElementById('login-error');
      const submitBtn = document.getElementById('login-submit');
      const password = pwInput.value;
      if (!password) return;

      errorEl.innerText = '';
      submitBtn.disabled = true;
      submitBtn.innerText = 'Logging in...';
      try {
        const data = await API.login(password);
        if (data.success) {
          pwInput.value = '';
          hideAuthOverlay();
          boot();
        } else {
          errorEl.innerText = data.error || 'Login failed.';
        }
      } catch (e) {
        errorEl.innerText = 'Network error.';
      }
      submitBtn.disabled = false;
      submitBtn.innerText = 'Log In';
    });
  }

  const setupForm = document.getElementById('setup-form');
  if (setupForm) {
    setupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('setup-password').value;
      const confirm = document.getElementById('setup-confirm').value;
      const errorEl = document.getElementById('setup-error');
      const submitBtn = document.getElementById('setup-submit');

      errorEl.innerText = '';
      if (pw.length < 8) { errorEl.innerText = 'Password must be at least 8 characters.'; return; }
      if (pw !== confirm) { errorEl.innerText = 'Passwords do not match.'; return; }

      submitBtn.disabled = true;
      submitBtn.innerText = 'Saving...';
      try {
        const data = await API.setupPassword(pw);
        if (data.success) {
          document.getElementById('setup-password').value = '';
          document.getElementById('setup-confirm').value = '';
          hideAuthOverlay();
          boot();
        } else {
          errorEl.innerText = data.error || 'Setup failed.';
        }
      } catch (e) {
        errorEl.innerText = 'Network error.';
      }
      submitBtn.disabled = false;
      submitBtn.innerText = 'Set Password & Continue';
    });
  }
}

function restoreTab() {
  const activeTab = localStorage.getItem('activeTab') || 'overview';
  switchTab(activeTab);
  if (activeTab === 'settings') loadSettings();
  if (activeTab === 'modules') loadGroups();
}

let localUptimeMs = 0;
let localUptimeInterval;

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000) % 60;
  const hours = Math.floor(ms / 3600000) % 24;
  const days = Math.floor(ms / 86400000);
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function setupEventListeners() {
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = btn.dataset.tab;
      switchTab(tab);
      if (tab === 'settings') loadSettings();
      if (tab === 'modules') loadGroups();
    });
  });

  document.getElementById('pair-form').addEventListener('submit', handlePairing);
  document.getElementById('logout-btn')?.addEventListener('click', handleLogout);
  document.getElementById('group-select').addEventListener('change', (e) => {
    selectedGroupId = e.target.value;
    renderGroupToggles();
  });
}

async function boot() {
  await checkStatus();
  updateConnectionUI(); // MUST call this unconditionally on boot to show the QR section if disconnected
  if (!isConnected) {
    statusInterval = setInterval(checkStatus, 3000);
    qrInterval = setInterval(fetchQR, 3000);
  } else {
    loadDashboard();
    restoreTab();
  }
}

async function checkStatus() {
  try {
    const data = await API.fetchStatus();
    document.getElementById('val-reconnects').innerText = data.reconnectAttempt || '0';
    
    const newlyConnected = data.status === 'connected' || data.status === 'open';
    if (newlyConnected !== isConnected) {
      isConnected = newlyConnected;
      updateConnectionUI();
    }
  } catch(e) {
    console.error("Failed to check status", e);
  }
}

function updateConnectionUI() {
  const pill = document.getElementById('status-pill');
  const text = document.getElementById('header-status-text');
  const viewPair = document.getElementById('view-pairing');

  if (isConnected) {
    if (pill) pill.className = 'status-pill connected';
    if (text) text.innerText = 'Connected';
    if (viewPair) viewPair.style.display = 'none';
    
    clearInterval(statusInterval);
    clearInterval(qrInterval);
    loadDashboard();
    restoreTab();
  } else {
    if (pill) pill.className = 'status-pill waiting_qr';
    if (text) text.innerText = 'Connecting...';
    if (viewPair) viewPair.style.display = 'block';
  }
}

async function fetchQR() {
  if (isConnected) return;
  try {
    const data = await API.fetchQR();
    if (data.status === 'qr' && data.qr) {
      document.getElementById('qr-image').src = data.qr;
      document.getElementById('qr-container').style.display = 'flex';
    }
  } catch(e) {}
}

async function handlePairing(e) {
  e.preventDefault();
  const phone = document.getElementById('phone-input').value;
  if (!phone) return showToast('Enter phone number', 'error');

  const btn = document.getElementById('pair-btn');
  btn.innerText = 'Requesting...';
  try {
    const data = await API.requestPairCode(phone);
    if (data.code) {
      const display = document.getElementById('pair-code-display');
      display.innerText = data.code;
      display.style.display = 'block';
      showToast('Pairing code generated');
    } else {
      showToast(data.error || 'Failed to get code', 'error');
    }
  } catch(e) {
    showToast('Network error', 'error');
  }
  btn.innerText = 'Get Code';
}

async function loadDashboard() {
  try {
    const data = await API.fetchUptime();
    localUptimeMs = data.uptimeMs || 0;
    
    document.getElementById('val-uptime').innerText = formatUptime(localUptimeMs);
    document.getElementById('val-node').innerText = data.nodeVersion || '--';
    document.getElementById('val-bot').innerText = data.botVersion || '--';

    if (localUptimeInterval) clearInterval(localUptimeInterval);
    localUptimeInterval = setInterval(() => {
        localUptimeMs += 1000;
        const uptimeEl = document.getElementById('val-uptime');
        if (uptimeEl) uptimeEl.innerText = formatUptime(localUptimeMs);
    }, 1000);
  } catch(e) {}
}

async function loadSettings() {
  try {
    const data = await API.fetchConfig();
    if (document.getElementById('cfg-prefix')) document.getElementById('cfg-prefix').value = data.prefix || '';
    if (document.getElementById('cfg-mods')) document.getElementById('cfg-mods').value = data.mods || '';
    if (document.getElementById('cfg-packname')) document.getElementById('cfg-packname').value = data.packname || '';
    if (document.getElementById('cfg-author')) document.getElementById('cfg-author').value = data.author || '';
    if (document.getElementById('cfg-gemini')) document.getElementById('cfg-gemini').value = data.geminiAPI || '';
    if (document.getElementById('cfg-tmdb')) document.getElementById('cfg-tmdb').value = data.tmdbAPI || '';
    if (document.getElementById('cfg-openai')) document.getElementById('cfg-openai').value = data.openaiAPI || '';
    if (document.getElementById('cfg-claude')) document.getElementById('cfg-claude').value = data.claudeAPI || '';
    if (document.getElementById('cfg-tenor')) document.getElementById('cfg-tenor').value = data.tenorAPI || '';
    if (document.getElementById('cfg-gc')) document.getElementById('cfg-gc').value = data.gcInterval || '';
    if (document.getElementById('cfg-yt-cookies')) document.getElementById('cfg-yt-cookies').value = data.ytCookies || '';
    if (document.getElementById('cfg-rapidapi')) document.getElementById('cfg-rapidapi').value = data.rapidapiKey || '';
  } catch(e) {
    showToast('Failed to load config', 'error');
  }
}

window.changeDashboardPassword = async function() {
  const curEl = document.getElementById('cfg-cur-pass');
  const newEl = document.getElementById('cfg-new-pass');
  const current = curEl.value;
  const next = newEl.value;
  if (!current || !next) return showToast('Fill in both fields', 'error');
  if (next.length < 8) return showToast('New password must be at least 8 characters', 'error');
  try {
    const data = await API.changePassword(current, next);
    if (data.success) {
      curEl.value = '';
      newEl.value = '';
      showToast('Dashboard password updated');
    } else {
      showToast(data.error || 'Failed to update password', 'error');
    }
  } catch (e) {
    showToast('Network error', 'error');
  }
};

window.saveConfig = async function(key, inputId) {
  const val = document.getElementById(inputId).value;
  try {
    const data = await API.saveConfig(key, val);
    if (data.success) showToast('Configuration saved!');
    else showToast('Failed to save', 'error');
  } catch(e) {
    showToast('Network error', 'error');
  }
};

async function loadGroups() {
  try {
    groupsData = await API.fetchGroups();
    const select = document.getElementById('group-select');
    select.innerHTML = '<option value="" disabled selected>Select Group...</option>';
    groupsData.forEach(g => {
      select.innerHTML += `<option value="${g.id}">${g.name || g.id}</option>`;
    });
  } catch(e) {}
}

function renderGroupToggles() {
  const list = document.getElementById('toggles-list');
  list.innerHTML = '';
  if (!selectedGroupId) return;

  const group = groupsData.find(g => g.id === selectedGroupId);
  if (!group) return;

  Object.keys(featureLabels).forEach(feat => {
    const val = group[feat] || false;
    const info = featureLabels[feat];
    
    list.innerHTML += `
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-info">
            <h3>${info.name}</h3>
            <p>${info.desc}</p>
          </div>
          <label class="switch">
            <input type="checkbox" ${val ? 'checked' : ''} onchange="toggleFeature('${feat}', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
      </div>
    `;
  });
}

window.toggleFeature = async function(feature, value) {
  if (!selectedGroupId) return;
  try {
    const data = await API.toggleGroupFeature(selectedGroupId, feature, value);
    if (data.success) {
      showToast(`${featureLabels[feature].name} updated!`);
      const grp = groupsData.find(g => g.id === selectedGroupId);
      if (grp) grp[feature] = value;
    } else {
      showToast('Update failed', 'error');
      renderGroupToggles();
    }
  } catch(e) {
    showToast('Network error', 'error');
    renderGroupToggles();
  }
};

async function loadBans() {
  try {
    const data = await API.fetchBans();
    // Implementation omitted for brevity, similar to old app
    // Needs HTML for bans rendering
} catch(e) {}
}

async function handleLogout() {
  clearInterval(statusInterval);
  clearInterval(qrInterval);
  clearInterval(localUptimeInterval);
  try {
    await API.logout();
  } catch (e) {}
  window.location.reload();
}

async function clearSession() {
  if (!confirm("Are you sure you want to clear the session? This will disconnect the bot and you will need to scan a new QR code.")) {
    return;
  }
  
  try {
    const res = await fetch("/api/clear-session", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      alert("Session cleared successfully. The bot is restarting...");
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } else {
      alert("Failed to clear session: " + (data.error || data.message));
    }
  } catch (err) {
    alert("Error clearing session: " + err.message);
  }
}
