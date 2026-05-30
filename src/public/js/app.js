document.addEventListener('DOMContentLoaded', () => {
    // Tab switching
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.add('hidden', 'active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-target');
            document.getElementById(targetId).classList.remove('hidden');
            document.getElementById(targetId).classList.add('active');
        });
    });

    // EventSource for Status & QR
    const statusBadge = document.getElementById('status-badge');
    const statusText = statusBadge.querySelector('.status-text');
    const qrContainer = document.getElementById('qr-container');
    const qrImage = document.getElementById('qr-image');
    const connectedState = document.getElementById('connected-state');

    function updateStatusUI(status, hasQR) {
        statusBadge.className = `status-badge ${status}`;
        statusText.textContent = status.replace('_', ' ');

        if (status === 'waiting_qr' && hasQR) {
            qrContainer.classList.remove('hidden');
            connectedState.classList.add('hidden');
        } else if (status === 'connected') {
            qrContainer.classList.add('hidden');
            connectedState.classList.remove('hidden');
        } else {
            qrContainer.classList.add('hidden');
            connectedState.classList.add('hidden');
        }
    }

    const es = new EventSource('/api/events');
    es.addEventListener('status', (e) => {
        const data = JSON.parse(e.data);
        updateStatusUI(data.status, data.hasQR);
    });

    // Poll for QR image updates if in waiting_qr state
    setInterval(() => {
        if (statusBadge.classList.contains('waiting_qr')) {
            qrImage.src = `/qr-image?t=${Date.now()}`;
        }
    }, 2000);

    // Initial load
    fetch('/api/stats').then(r => r.json()).then(data => {
        document.getElementById('stat-msgs').textContent = data.messagesProcessed || 0;
        document.getElementById('stat-uptime').textContent = formatUptime(data.uptime);
        document.getElementById('stat-groups').textContent = data.groups || 0;
        document.getElementById('stat-banned').textContent = data.banned || 0;
    }).catch(console.error);

    function formatUptime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    }

    // System Commands
    document.getElementById('btn-reconnect').addEventListener('click', () => {
        if (confirm("Force a reconnection?")) {
            fetch('/api/system/reconnect', { method: 'POST' });
        }
    });

    document.getElementById('btn-wipe').addEventListener('click', () => {
        if (confirm("WARNING: This will wipe the session and require re-scanning the QR code. Continue?")) {
            fetch('/api/system/wipe', { method: 'POST' });
        }
    });

    // Logs Terminal
    const terminalOutput = document.getElementById('terminal-output');
    document.getElementById('btn-clear-logs').addEventListener('click', () => {
        terminalOutput.innerHTML = '<div class="log-line sys">Logs cleared.</div>';
    });

    const btnBroadcast = document.getElementById('btn-broadcast');
    const inputBroadcast = document.getElementById('input-broadcast');
    const broadcastStatus = document.getElementById('broadcast-status');

    btnBroadcast.addEventListener('click', async () => {
        const text = inputBroadcast.value.trim();
        if (!text) return;
        btnBroadcast.disabled = true;
        btnBroadcast.textContent = 'Sending...';
        broadcastStatus.textContent = '';
        
        try {
            const res = await fetch('/api/system/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            broadcastStatus.textContent = 'Broadcast sent successfully!';
            broadcastStatus.style.color = 'var(--accent)';
            inputBroadcast.value = '';
        } catch (err) {
            broadcastStatus.textContent = 'Failed: ' + err.message;
            broadcastStatus.style.color = 'var(--danger)';
        } finally {
            btnBroadcast.disabled = false;
            btnBroadcast.textContent = 'Send Broadcast';
        }
    });

    const logStream = new EventSource('/api/logs');
    logStream.addEventListener('log', (e) => {
        const div = document.createElement('div');
        div.className = 'log-line';
        
        try {
            const data = JSON.parse(e.data);
            div.textContent = `[${new Date(data.time).toLocaleTimeString()}] ${data.msg}`;
            if (data.level >= 50) div.classList.add('error');
            else if (data.level >= 40) div.classList.add('warn');
            else if (data.level === 30) div.classList.add('info');
        } catch {
            div.textContent = e.data;
        }

        terminalOutput.appendChild(div);
        if (terminalOutput.childElementCount > 100) {
            terminalOutput.removeChild(terminalOutput.firstChild);
        }
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
    });

});
