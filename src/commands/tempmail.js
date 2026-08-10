import { replyMsg, reactMsg, alertOwner } from "./helpers.js";

// ─── mail.tm API Wrapper ──────────────────────────────────────────────────────

const API_BASE = "https://api.mail.tm";

async function fetchApi(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = { "Content-Type": "application/json", ...options.headers };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`API Error ${res.status}: ${errorText}`);
  }
  // Return buffer for attachments, otherwise JSON
  if (options.isBuffer) {
    return Buffer.from(await res.arrayBuffer());
  }
  return res.json();
}

async function getDomain() {
  const data = await fetchApi("/domains");
  if (!data['hydra:member'] || data['hydra:member'].length === 0) {
    throw new Error("No domains available on mail.tm right now.");
  }
  return data['hydra:member'][0].domain;
}

async function createAccount(address, password) {
  return fetchApi("/accounts", {
    method: "POST",
    body: JSON.stringify({ address, password })
  });
}

async function getToken(address, password) {
  const data = await fetchApi("/token", {
    method: "POST",
    body: JSON.stringify({ address, password })
  });
  return data.token;
}

async function getMessages(token) {
  const data = await fetchApi("/messages", {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data['hydra:member'] || [];
}

async function getMessageData(id, token) {
  return fetchApi(`/messages/${id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function downloadAttachment(id, attachmentId, token) {
  return fetchApi(`/messages/${id}/attachment/${attachmentId}`, {
    headers: { Authorization: `Bearer ${token}` },
    isBuffer: true
  });
}

// ─── State Management ─────────────────────────────────────────────────────────

// Map of JID -> Session Object
// Session Object: { address, password, token, intervalId, expireTimeoutId, seenMessageIds: Set }
const activeSessions = new Map();

// ─── Helper Functions ─────────────────────────────────────────────────────────

function stopSession(jid) {
  const session = activeSessions.get(jid);
  if (session) {
    clearInterval(session.intervalId);
    clearTimeout(session.expireTimeoutId);
    activeSessions.delete(jid);
  }
}

async function pollInbox(sock, from, jid) {
  const session = activeSessions.get(jid);
  if (!session) return;

  try {
    const messages = await getMessages(session.token);
    
    // Process new messages
    for (const msg of messages) {
      if (!session.seenMessageIds.has(msg.id)) {
        session.seenMessageIds.add(msg.id);
        
        // Fetch full content
        const fullMsg = await getMessageData(msg.id, session.token);
        
        // Prepare WhatsApp message
        let text = `📧 *New Email Received!*\n\n`;
        text += `*From:* ${fullMsg.from.address}\n`;
        text += `*Subject:* ${fullMsg.subject || "(No Subject)"}\n\n`;
        text += `*Message:*\n${fullMsg.text || "(No Text Content)"}`;
        
        await sock.sendMessage(from, { text });
        
        // Handle attachments
        if (fullMsg.attachments && fullMsg.attachments.length > 0) {
          await sock.sendMessage(from, { text: `📎 *Downloading ${fullMsg.attachments.length} attachment(s)...*` });
          for (const att of fullMsg.attachments) {
            try {
              const buffer = await downloadAttachment(msg.id, att.id, session.token);
              await sock.sendMessage(from, {
                document: buffer,
                mimetype: att.contentType || "application/octet-stream",
                fileName: att.name || "attachment"
              });
            } catch (_err) {
              await sock.sendMessage(from, { text: `❌ Failed to download attachment: ${att.name}` });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[TempMail] Polling error for ${session.address}:`, err.message);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const tempmailCommands = {
  tempmail: {
    adminOnly: false,
    requiresArgs: false,
    description: "Generate a disposable email and forward incoming messages to WhatsApp",
    usage: "!tempmail [stop]",
    examples: ["!tempmail", "!tempmail stop"],
    handler: async (sock, msg, args, from, prefix) => {
      const senderJid = msg.key.participant || msg.key.remoteJid;
      const cmdArg = args[0]?.toLowerCase();

      // STOP COMMAND
      if (cmdArg === "stop") {
        if (!activeSessions.has(senderJid)) {
          return replyMsg(sock, from, msg, "❌ You don't have an active temporary email session.");
        }
        const session = activeSessions.get(senderJid);
        stopSession(senderJid);
        return replyMsg(sock, from, msg, `✅ Stopped monitoring your temporary email:\n📧 *${session.address}*\nIt is now discarded.`);
      }

      // PREVENT MULTIPLE SESSIONS
      if (activeSessions.has(senderJid)) {
        const session = activeSessions.get(senderJid);
        return replyMsg(sock, from, msg, `⚠️ You already have an active temporary email!\n\n📧 *${session.address}*\n\nInbox is being monitored. Use *${prefix}tempmail stop* to discard it.`);
      }

      // CREATE NEW SESSION
      await reactMsg(sock, from, msg, "⏳");
      
      try {
        const domain = await getDomain();
        const randomString = Math.random().toString(36).substring(2, 12);
        const address = `${randomString}@${domain}`;
        const password = Math.random().toString(36).substring(2, 15);
        
        await createAccount(address, password);
        const token = await getToken(address, password);
        
        // Start 6-second polling loop
        const intervalId = setInterval(() => pollInbox(sock, from, senderJid), 6000);
        
        // Set 45-minute expiry
        const expireTimeoutId = setTimeout(async () => {
          stopSession(senderJid);
          try {
            await sock.sendMessage(from, { text: `⏱️ Your temporary email *${address}* has expired (45 mins limit reached) and is no longer being monitored.` });
          } catch {}
        }, 45 * 60 * 1000);

        activeSessions.set(senderJid, {
          address,
          password,
          token,
          intervalId,
          expireTimeoutId,
          seenMessageIds: new Set()
        });

        await reactMsg(sock, from, msg, "✅");
        const replyText = `✅ *Temporary Email Created!*\n\n📧 *Address:* \`${address}\`\n\nI will monitor this inbox for the next 45 minutes and forward any emails and attachments directly to this chat.\n\n_To discard early, type *${prefix}tempmail stop*_`;
        
        return replyMsg(sock, from, msg, replyText);

      } catch (err) {
        console.error("TempMail creation error:", err);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Failed to create temporary email: ${err.message}`);
        await alertOwner(sock, `${prefix}tempmail`, err);
      }
    }
  }
};
