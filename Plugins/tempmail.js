import axios from "axios";
import crypto from "crypto";

const API = "https://api.mail.tm";
const rand = (n) => crypto.randomBytes(n).toString("hex").slice(0, n);
const key = (sender) => `tempmail:${sender}`;

const http = axios.create({
  baseURL: API,
  timeout: 20000,
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  validateStatus: () => true,
});

async function loadSession(db, sender) {
  const raw = await db.getSetting(key(sender), "");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
const saveSession = (db, sender, s) => db.setSetting(key(sender), JSON.stringify(s));
const clearSession = (db, sender) => db.setSetting(key(sender), "");

async function pickDomain() {
  const res = await http.get("/domains?page=1");
  const list = res.data?.["hydra:member"] || [];
  const active = list.find((d) => d.isActive && !d.isPrivate) || list[0];
  if (!active) throw new Error("No mail.tm domains available right now.");
  return active.domain;
}

async function createInbox() {
  const domain = await pickDomain();
  const address = `hooper${rand(9)}@${domain}`;
  const password = rand(16);

  const acc = await http.post("/accounts", { address, password });
  if (acc.status !== 201 && acc.status !== 200) {
    throw new Error(`Could not create inbox (${acc.status}).`);
  }
  const token = await getToken(address, password);
  return { address, password, token, ids: [] };
}

async function getToken(address, password) {
  const res = await http.post("/token", { address, password });
  if (res.status !== 200 || !res.data?.token) {
    throw new Error(`Auth failed (${res.status}).`);
  }
  return res.data.token;
}

async function withAuth(session, req) {
  let res = await req(session.token);
  if (res.status === 401) {
    session.token = await getToken(session.address, session.password);
    res = await req(session.token);
  }
  return res;
}

async function listMessages(session) {
  const res = await withAuth(session, (token) =>
    http.get("/messages?page=1", { headers: { Authorization: `Bearer ${token}` } }),
  );
  if (res.status !== 200) throw new Error(`Inbox fetch failed (${res.status}).`);
  return res.data?.["hydra:member"] || [];
}

async function readMessage(session, id) {
  const res = await withAuth(session, (token) =>
    http.get(`/messages/${id}`, { headers: { Authorization: `Bearer ${token}` } }),
  );
  if (res.status !== 200) throw new Error(`Message fetch failed (${res.status}).`);
  return res.data;
}

async function deleteAccount(session) {
  try {
    const meRes = await withAuth(session, (token) =>
      http.get("/me", { headers: { Authorization: `Bearer ${token}` } }),
    );
    const accId = meRes.data?.id;
    if (accId) {
      await withAuth(session, (token) =>
        http.delete(`/accounts/${accId}`, { headers: { Authorization: `Bearer ${token}` } }),
      );
    }
  } catch {
    /* best effort */
  }
}

const fmtFrom = (f) => (f?.name ? `${f.name} <${f.address}>` : f?.address || "unknown");
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

export default {
  name: "tempmail",
  alias: ["tempmail", "tmail", "tm", "fakemail", "tmi"],
  uniquecommands: ["tempmail", "tm"],
  description: "Disposable email address with an inbox you can check from chat",

  start: async (Hooper, m, { inputCMD, args, text, prefix, doReact, db }) => {
    const sender = m.sender;
    const sub = (inputCMD === "tmi" ? "inbox" : (args[0] || "")).toLowerCase();
    const p = prefix;

    try {
      // ── new address ────────────────────────────────────────────────────
      if (sub === "new" || sub === "gen" || sub === "reset") {
        await doReact("⏳");
        const old = await loadSession(db, sender);
        if (old) await deleteAccount(old);
        const session = await createInbox();
        await saveSession(db, sender, session);
        await doReact("✅");
        return m.reply(
          `📧 *New temporary email*\n\n\`${session.address}\`\n\n` +
            `Check it with *${p}tempmail inbox*  ·  read one with *${p}tempmail read <n>*\n` +
            `_Powered by mail.tm — inbox is wiped when idle._`,
        );
      }

      // ── delete ─────────────────────────────────────────────────────────
      if (sub === "del" || sub === "delete" || sub === "stop") {
        const session = await loadSession(db, sender);
        if (!session) return m.reply(`You don't have a temporary email. Make one with *${p}tempmail*`);
        await deleteAccount(session);
        await clearSession(db, sender);
        await doReact("🗑️");
        return m.reply("🗑️ Temporary email deleted.");
      }

      // ── read a message ─────────────────────────────────────────────────
      if (sub === "read" || sub === "open" || sub === "view") {
        const session = await loadSession(db, sender);
        if (!session) return m.reply(`No temporary email yet. Make one with *${p}tempmail*`);
        const n = parseInt(args[1], 10);
        if (!n || n < 1) return m.reply(`Usage: *${p}tempmail read <number>*  (from the inbox list)`);

        await doReact("⏳");
        // refresh the list so `ids` is current, then resolve n -> id
        const msgs = await listMessages(session);
        session.ids = msgs.map((x) => x.id);
        await saveSession(db, sender, session);

        const id = session.ids[n - 1];
        if (!id) return m.reply(`No message #${n}. You have ${session.ids.length} message(s).`);

        const full = await readMessage(session, id);
        const body = (full.text || "").trim() || clip((full.html || []).join?.("\n") || "", 3000) || "(no text content)";
        await doReact("✅");
        return m.reply(
          `📩 *${clip(full.subject || "(no subject)", 120)}*\n` +
            `*From:* ${fmtFrom(full.from)}\n` +
            `*Date:* ${new Date(full.createdAt).toLocaleString()}\n` +
            `──────────────\n${clip(body, 3500)}`,
        );
      }

      // ── inbox ──────────────────────────────────────────────────────────
      if (sub === "inbox" || sub === "check" || sub === "list") {
        const session = await loadSession(db, sender);
        if (!session) return m.reply(`No temporary email yet. Make one with *${p}tempmail*`);

        await doReact("⏳");
        const msgs = await listMessages(session);
        session.ids = msgs.map((x) => x.id);
        await saveSession(db, sender, session);
        await doReact("✅");

        if (!msgs.length) {
          return m.reply(`📭 *${session.address}*\n\nInbox is empty. Try again in a bit.`);
        }
        const lines = msgs
          .slice(0, 15)
          .map(
            (x, i) =>
              `*${i + 1}.* ${x.seen ? "" : "🆕 "}${clip(x.subject || "(no subject)", 60)}\n` +
              `     ↳ ${fmtFrom(x.from)}${x.intro ? `\n     _${clip(x.intro, 70)}_` : ""}`,
          )
          .join("\n\n");
        return m.reply(
          `📬 *${session.address}* — ${msgs.length} message(s)\n\n${lines}\n\n` +
            `Read one with *${p}tempmail read <n>*`,
        );
      }

      // ── default: show current address (create if none) ─────────────────
      let session = await loadSession(db, sender);
      if (!session) {
        await doReact("⏳");
        session = await createInbox();
        await saveSession(db, sender, session);
      }
      await doReact("✅");
      return m.reply(
        `📧 *Your temporary email*\n\n\`${session.address}\`\n\n` +
          `• *${p}tempmail inbox* — check messages\n` +
          `• *${p}tempmail read <n>* — open a message\n` +
          `• *${p}tempmail new* — fresh address\n` +
          `• *${p}tempmail del* — delete it`,
      );
    } catch (err) {
      console.error("[ TEMPMAIL ] Error:", err.message);
      await doReact("❌");
      return m.reply(`❌ Temp-mail error: ${err.message}`);
    }
  },
};
