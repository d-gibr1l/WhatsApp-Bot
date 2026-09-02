import axios from "axios";
import crypto from "crypto";

// ── mail.tm client + in-memory watcher registry ─────────────────────────────
// The plugin drives commands; index.js runs a poller that walks `sessions`
// every few seconds and pushes new mail. Sessions are hydrated from the DB
// once at boot and kept in memory afterwards so the poll loop never touches
// MongoDB.

const API = "https://api.mail.tm";
const SETTING_PREFIX = "tempmail:";
const IDLE_MS = 2 * 60 * 60 * 1000; // stop watching an address after 2h idle
const MAX_SEEN = 60;

const http = axios.create({
  baseURL: API,
  timeout: 20000,
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  validateStatus: () => true,
});

const rand = (n) => crypto.randomBytes(n).toString("hex").slice(0, n);

// mail.tm returns a plain array for Accept: application/json and a Hydra
// collection for application/ld+json — handle both.
const members = (data) => (Array.isArray(data) ? data : data?.["hydra:member"] || []);

/** sender JID -> { address, password, token, ownerJid, seenIds:string[], lastActive:number } */
export const sessions = new Map();

// ── API ────────────────────────────────────────────────────────────────────

async function pickDomain() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await http.get("/domains?page=1");
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    const list = members(res.data);
    const active = list.find((d) => d.isActive && !d.isPrivate) || list[0];
    if (active) return active.domain;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("mail.tm is not responding right now — try again shortly.");
}

async function getToken(address, password) {
  const res = await http.post("/token", { address, password });
  if (res.status !== 200 || !res.data?.token) throw new Error(`Auth failed (${res.status}).`);
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

export async function createInbox(ownerJid) {
  const domain = await pickDomain();
  const address = `hooper${rand(9)}@${domain}`;
  const password = rand(16);
  const acc = await http.post("/accounts", { address, password });
  if (acc.status !== 201 && acc.status !== 200) throw new Error(`Could not create inbox (${acc.status}).`);
  const token = await getToken(address, password);
  return { address, password, token, ownerJid, seenIds: [], lastActive: Date.now() };
}

export async function listMessages(session) {
  const res = await withAuth(session, (t) =>
    http.get("/messages?page=1", { headers: { Authorization: `Bearer ${t}` } }),
  );
  if (res.status !== 200) throw new Error(`Inbox fetch failed (${res.status}).`);
  return members(res.data);
}

export async function readMessage(session, id) {
  const res = await withAuth(session, (t) =>
    http.get(`/messages/${id}`, { headers: { Authorization: `Bearer ${t}` } }),
  );
  if (res.status !== 200) throw new Error(`Message fetch failed (${res.status}).`);
  return res.data;
}

export async function deleteAccount(session) {
  try {
    const me = await withAuth(session, (t) =>
      http.get("/me", { headers: { Authorization: `Bearer ${t}` } }),
    );
    if (me.data?.id) {
      await withAuth(session, (t) =>
        http.delete(`/accounts/${me.data.id}`, { headers: { Authorization: `Bearer ${t}` } }),
      );
    }
  } catch {
    /* best effort */
  }
}

// ── persistence ────────────────────────────────────────────────────────────

const keyFor = (sender) => SETTING_PREFIX + sender;

export async function persist(db, sender) {
  const s = sessions.get(sender);
  if (!s) return db.setSetting(keyFor(sender), "");
  const trimmed = { ...s, seenIds: s.seenIds.slice(-MAX_SEEN) };
  return db.setSetting(keyFor(sender), JSON.stringify(trimmed));
}

export async function forget(db, sender) {
  sessions.delete(sender);
  return db.setSetting(keyFor(sender), "");
}

export function touch(sender) {
  const s = sessions.get(sender);
  if (s) s.lastActive = Date.now();
}

/** Load every stored tempmail session into memory. Call once after DB is up. */
export async function hydrate(db) {
  try {
    const all = await db.getAllSettings();
    let n = 0;
    for (const { key, value } of all) {
      if (!key.startsWith(SETTING_PREFIX) || !value) continue;
      try {
        const s = JSON.parse(value);
        if (!s?.address || !s?.password) continue;
        s.seenIds = Array.isArray(s.seenIds) ? s.seenIds : [];
        s.ownerJid = s.ownerJid || key.slice(SETTING_PREFIX.length);
        s.lastActive = s.lastActive || Date.now();
        sessions.set(key.slice(SETTING_PREFIX.length), s);
        n++;
      } catch {
        /* skip bad row */
      }
    }
    return n;
  } catch (e) {
    console.error("[ TEMPMAIL ] hydrate failed:", e.message);
    return 0;
  }
}

// ── poller ─────────────────────────────────────────────────────────────────

let polling = false;

/**
 * One poll cycle. `send(jid, message)` sends a WhatsApp message; `db` persists
 * seenIds. Processes accounts oldest-first with a gap between each so we stay
 * under mail.tm's rate limit even with many watchers.
 */
export async function pollOnce({ send, db }) {
  if (polling) return;
  polling = true;
  try {
    const now = Date.now();
    const entries = [...sessions.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);

    for (const [sender, s] of entries) {
      // drop idle sessions (mail.tm has wiped them anyway)
      if (now - s.lastActive > IDLE_MS) {
        await forget(db, sender).catch(() => {});
        continue;
      }
      try {
        const msgs = await listMessages(s);
        const fresh = msgs.filter((mm) => !s.seenIds.includes(mm.id));
        if (!fresh.length) continue;

        // oldest first so they arrive in order
        for (const meta of fresh.reverse()) {
          s.seenIds.push(meta.id);
          let bodyText = "";
          try {
            const full = await readMessage(s, meta.id);
            bodyText = (full.text || "").trim();
            if (!bodyText && Array.isArray(full.html)) bodyText = full.html.join("\n");
          } catch {
            bodyText = meta.intro || "";
          }
          const from = meta.from?.name ? `${meta.from.name} <${meta.from.address}>` : meta.from?.address || "unknown";
          const clip = (t, n) => (t && t.length > n ? t.slice(0, n - 1) + "…" : t || "");
          await send(
            s.ownerJid,
            `📨 *New mail* → \`${s.address}\`\n\n` +
              `*Subject:* ${clip(meta.subject || "(no subject)", 140)}\n` +
              `*From:* ${from}\n` +
              `──────────────\n${clip(bodyText || "(no text content)", 3500)}`,
          );
        }
        await persist(db, sender).catch(() => {});
      } catch (e) {
        // one bad account must not stop the loop
        if (!/429|Auth failed/.test(e.message)) {
          console.error(`[ TEMPMAIL ] poll ${s.address}:`, e.message);
        }
      }
      await new Promise((r) => setTimeout(r, 200)); // stay under 8 req/s
    }
  } finally {
    polling = false;
  }
}
