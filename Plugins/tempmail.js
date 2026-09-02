import {
  sessions,
  createInbox,
  listMessages,
  readMessage,
  deleteAccount,
  persist,
  forget,
  touch,
} from "../src/tempmail.js";

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const fmtFrom = (f) => (f?.name ? `${f.name} <${f.address}>` : f?.address || "unknown");

export default {
  name: "tempmail",
  alias: ["tempmail", "tmail", "tm", "fakemail", "tmi"],
  uniquecommands: ["tempmail", "tm"],
  description: "Disposable email — new mail is pushed to you automatically",

  start: async (Hooper, m, { inputCMD, args, prefix, doReact, db }) => {
    const sender = m.sender;
    const p = prefix;
    const sub = (inputCMD === "tmi" ? "inbox" : (args[0] || "")).toLowerCase();

    try {
      // ── new / reset ────────────────────────────────────────────────────
      if (sub === "new" || sub === "gen" || sub === "reset") {
        await doReact("⏳");
        const old = sessions.get(sender);
        if (old) await deleteAccount(old);
        const session = await createInbox(sender);
        sessions.set(sender, session);
        await persist(db, sender);
        await doReact("✅");
        return m.reply(
          `📧 *New temporary email*\n\n\`${session.address}\`\n\n` +
            `New mail is delivered here automatically. You can also run *${p}tempmail inbox*.`,
        );
      }

      // ── delete ─────────────────────────────────────────────────────────
      if (sub === "del" || sub === "delete" || sub === "stop") {
        const session = sessions.get(sender);
        if (!session) return m.reply(`You don't have a temporary email. Make one with *${p}tempmail*`);
        await deleteAccount(session);
        await forget(db, sender);
        await doReact("🗑️");
        return m.reply("🗑️ Temporary email deleted. Auto-delivery stopped.");
      }

      // ── read a message ─────────────────────────────────────────────────
      if (sub === "read" || sub === "open" || sub === "view") {
        const session = sessions.get(sender);
        if (!session) return m.reply(`No temporary email yet. Make one with *${p}tempmail*`);
        touch(sender);
        const n = parseInt(args[1], 10);
        if (!n || n < 1) return m.reply(`Usage: *${p}tempmail read <number>*  (from the inbox list)`);

        await doReact("⏳");
        const msgs = await listMessages(session);
        const id = msgs[n - 1]?.id;
        if (!id) return m.reply(`No message #${n}. You have ${msgs.length} message(s).`);

        const full = await readMessage(session, id);
        let body = (full.text || "").trim();
        if (!body && Array.isArray(full.html)) body = full.html.join("\n");
        await doReact("✅");
        return m.reply(
          `📩 *${clip(full.subject || "(no subject)", 120)}*\n` +
            `*From:* ${fmtFrom(full.from)}\n` +
            `*Date:* ${new Date(full.createdAt).toLocaleString()}\n` +
            `──────────────\n${clip(body || "(no text content)", 3500)}`,
        );
      }

      // ── inbox ──────────────────────────────────────────────────────────
      if (sub === "inbox" || sub === "check" || sub === "list") {
        const session = sessions.get(sender);
        if (!session) return m.reply(`No temporary email yet. Make one with *${p}tempmail*`);
        touch(sender);

        await doReact("⏳");
        const msgs = await listMessages(session);
        // mark everything as seen so the poller doesn't re-push what you just read
        session.seenIds = [...new Set([...session.seenIds, ...msgs.map((x) => x.id)])];
        await persist(db, sender);
        await doReact("✅");

        if (!msgs.length) return m.reply(`📭 *${session.address}*\n\nInbox is empty.`);
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
      let session = sessions.get(sender);
      if (!session) {
        await doReact("⏳");
        session = await createInbox(sender);
        sessions.set(sender, session);
        await persist(db, sender);
      } else {
        touch(sender);
      }
      await doReact("✅");
      return m.reply(
        `📧 *Your temporary email*\n\n\`${session.address}\`\n\n` +
          `📨 New mail is pushed here automatically.\n\n` +
          `• *${p}tempmail inbox* — list messages\n` +
          `• *${p}tempmail read <n>* — open one\n` +
          `• *${p}tempmail new* — fresh address\n` +
          `• *${p}tempmail del* — delete + stop delivery`,
      );
    } catch (err) {
      console.error("[ TEMPMAIL ] Error:", err.message);
      await doReact("❌");
      return m.reply(`❌ Temp-mail error: ${err.message}`);
    }
  },
};
