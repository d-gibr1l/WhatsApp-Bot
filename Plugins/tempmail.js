const API_BASE = "https://api.mail.tm";

async function fetchApi(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = { "Content-Type": "application/json", ...options.headers };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`API Error ${res.status}: ${errorText}`);
  }
  if (options.isBuffer) {
    return Buffer.from(await res.arrayBuffer());
  }
  return res.json();
}

async function getDomain() {
  const data = await fetchApi("/domains");
  if (!data["hydra:member"] || data["hydra:member"].length === 0) {
    throw new Error("No domains available on mail.tm right now.");
  }
  return data["hydra:member"][0].domain;
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
  return data["hydra:member"] || [];
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

// Map of JID -> Session Object
const activeSessions = new Map();

function stopSession(jid) {
  const session = activeSessions.get(jid);
  if (session) {
    clearInterval(session.intervalId);
    clearTimeout(session.expireTimeoutId);
    activeSessions.delete(jid);
  }
}

async function pollInbox(Hooper, from, jid) {
  const session = activeSessions.get(jid);
  if (!session) return;

  try {
    const messages = await getMessages(session.token);
    
    for (const msg of messages) {
      if (!session.seenMessageIds.has(msg.id)) {
        session.seenMessageIds.add(msg.id);
        
        const fullMsg = await getMessageData(msg.id, session.token);
        
        let text = `📧 *New Email Received!*\n\n`;
        text += `*From:* ${fullMsg.from.address}\n`;
        text += `*Subject:* ${fullMsg.subject || "(No Subject)"}\n\n`;
        text += `*Message:*\n${fullMsg.text || "(No Text Content)"}`;
        
        await Hooper.sendMessage(from, { text });
        
        if (fullMsg.attachments && fullMsg.attachments.length > 0) {
          await Hooper.sendMessage(from, { text: `📥 *Downloading ${fullMsg.attachments.length} attachment(s)...*` });
          for (const att of fullMsg.attachments) {
            try {
              const buffer = await downloadAttachment(msg.id, att.id, session.token);
              await Hooper.sendMessage(from, {
                document: buffer,
                mimetype: att.contentType || "application/octet-stream",
                fileName: att.name || "attachment"
              });
            } catch (_err) {
              await Hooper.sendMessage(from, { text: `❌ Failed to download attachment: ${att.name}` });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[TempMail] Polling error for ${session.address}:`, err.message);
  }
}

export default {
  name: "tammail",
  alias: ["tm", "tempmail"],
  category: "Utility",
  desc: "Generate a disposable email and forward incoming messages to WhatsApp",
  usage: "tammail [stop]",
  run: async (Hooper, m, { args, command, prefix }) => {
    const senderJid = m.sender;
    const from = m.from;
    const cmdArg = args[0]?.toLowerCase();

    if (cmdArg === "stop") {
      if (!activeSessions.has(senderJid)) {
        return m.reply("❌ You don't have an active temporary email session.");
      }
      const session = activeSessions.get(senderJid);
      stopSession(senderJid);
      return m.reply(`🛑 Stopped monitoring your temporary email:\n📧 *${session.address}*\nIt is now discarded.`);
    }

    if (activeSessions.has(senderJid)) {
      const session = activeSessions.get(senderJid);
      return m.reply(`⚠️ You already have an active temporary email!\n\n📧 *${session.address}*\n\nInbox is being monitored. Use *${prefix}tammail stop* to discard it.`);
    }

    await Hooper.sendMessage(from, { react: { text: "⏳", key: m.key } });
    
    try {
      const domain = await getDomain();
      const randomString = Math.random().toString(36).substring(2, 12);
      const address = `${randomString}@${domain}`;
      const password = Math.random().toString(36).substring(2, 15);
      
      await createAccount(address, password);
      const token = await getToken(address, password);
      
      const intervalId = setInterval(() => pollInbox(Hooper, from, senderJid), 6000);
      
      const expireTimeoutId = setTimeout(async () => {
        stopSession(senderJid);
        try {
          await Hooper.sendMessage(from, { text: `⏳ Your temporary email *${address}* has expired (45 mins limit reached) and is no longer being monitored.` });
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

      await Hooper.sendMessage(from, { react: { text: "✅", key: m.key } });
      const replyText = `✅ *Temporary Email Created!*\n\n📧 *Address:* \`${address}\`\n\nI will monitor this inbox for the next 45 minutes and forward any emails and attachments directly to this chat.\n\n_To discard early, type *${prefix}tammail stop*_`;
      
      return m.reply(replyText);

    } catch (err) {
      console.error("TempMail creation error:", err);
      await Hooper.sendMessage(from, { react: { text: "❌", key: m.key } });
      await m.reply(`❌ Failed to create temporary email: ${err.message}`);
    }
  }
};
