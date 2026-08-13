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
  nsfw: { name: 'NSFW Content', desc: 'Allow mature API commands.' }
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  setupEventListeners();
  boot();
});

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
  document.getElementById('group-select').addEventListener('change', (e) => {
    selectedGroupId = e.target.value;
    renderGroupToggles();
  });
}

async function boot() {
  await checkStatus();
  if (!isConnected) {
    statusInterval = setInterval(checkStatus, 3000);
    qrInterval = setInterval(fetchQR, 3000);
  } else {
    loadDashboard();
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
    document.getElementById('val-uptime').innerText = data.uptime || '--';
    document.getElementById('val-node').innerText = data.nodeVersion || '--';
    document.getElementById('val-bot').innerText = data.botVersion || '--';
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
  } catch(e) {
    showToast('Failed to load config', 'error');
  }
}

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
