// Handles all external backend communication
const API = {
  async login(password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    return res.json();
  },

  async logout() {
    const res = await fetch('/api/logout', { method: 'POST' });
    return res.json();
  },

  async fetchStatus() {
    const res = await fetch('/api/status');
    return res.json();
  },
  
  async fetchQR() {
    const res = await fetch('/api/qr');
    return res.json();
  },
  
  async requestPairCode(phone) {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    return res.json();
  },

  async fetchUptime() {
    const res = await fetch('/api/uptime');
    return res.json();
  },

  async fetchConfig() {
    const res = await fetch('/api/config');
    return res.json();
  },

  async saveConfig(key, value) {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value })
    });
    return res.json();
  },

  async fetchGroups() {
    const res = await fetch('/api/groups');
    return res.json();
  },

  async toggleGroupFeature(groupId, feature, value) {
    const res = await fetch(`/api/groups/${groupId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature, value })
    });
    return res.json();
  },

  async fetchBans() {
    const res = await fetch('/api/bans');
    return res.json();
  },

  async banEntity(id, type) {
    const res = await fetch('/api/bans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, type })
    });
    return res.json();
  },

  async unbanEntity(id, type) {
    const res = await fetch(`/api/bans/${id}?type=${type}`, { method: 'DELETE' });
    return res.json();
  },

  async fetchPlugins() {
    const res = await fetch('/api/plugins');
    return res.json();
  }
};

export default API;
