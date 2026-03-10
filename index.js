import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

import { SESSION_DIR, MAX_RECONNECTS, BASE_DELAY_MS, BOT_NUMBER } from "./src/config.js";
import { hydrateSessionFromSupabase, saveSessionToSupabase, clearSessionFromSupabase } from "./src/session.js";
import { handleMessage, startReminderPoller } from "./src/handler.js";
import { loadWordFilter } from "./src/commands/wordfilter.js";
import { loadAllowedLinks } from "./src/commands/antilink.js";
import { handleAntiDelete, storeMessage } from "./src/commands/antidelete.js";
import { loadCache } from "./src/cache.js";
import { startServer, setQR, setConnected, setDisconnected, setStarting } from "./src/server.js";

const logger = pino({ level: "silent" });

startServer();

async function startBot(attempt = 1) {
  console.log(`🔄 Starting bot (attempt ${attempt})...`);
  setStarting();

  try {
    await hydrateSessionFromSupabase();

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📦 Baileys ${version.join(".")} ${isLatest ? "(latest)" : "(outdated)"}`);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      await saveSessionToSupabase(state.creds, state.keys);
    });

    sock.ev.on("messaging-history.set", ({ messages }) => {
      console.log(`📥 History sync (${messages.length} msgs) — ignored.`);
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        setQR(qr);
        console.log("📷 QR ready — visit your service URL to scan");
      }

      if (connection === "open") {
        setConnected();
        await loadCache();
        await loadWordFilter();
        await loadAllowedLinks();

        // ─── Anti-delete listener ────────────────────────────────────
        sock.ev.on("messages.delete", async (item) => {
          try {
            if (item.keys) {
              for (const key of item.keys) {
                await handleAntiDelete(sock, key);
              }
            } else if (item.key) {
              await handleAntiDelete(sock, item.key);
            }
          } catch (err) {
            console.error("❌ Anti-delete handler error:", err.message);
          }
        });
        startReminderPoller(sock);
        console.log("✅ Bot connected and ready!");
      }

      if (connection === "close") {
        setDisconnected();

        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode
            : lastDisconnect?.error?.output?.statusCode;

        const reason =
          Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0] ?? "Unknown";

        console.warn(`⚠️  Disconnected — ${reason} (${statusCode})`);

        if (statusCode === DisconnectReason.connectionReplaced) {
          console.error("🔄 Connection replaced by newer instance. Exiting cleanly.");
          process.exit(0);
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.error("🚪 Logged out. Clearing session...");
          await clearSessionFromSupabase();
          process.exit(0);
        }

        if (attempt >= MAX_RECONNECTS) {
          console.error("❌ Max reconnects reached. Exiting.");
          process.exit(1);
        }

        const delay = Math.min(
          BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1000,
          60_000
        );
        console.log(`🔁 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
        setTimeout(() => startBot(attempt + 1), delay);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        // Store message for anti-delete before processing
const { extractText } = await import("./src/handler.js");
storeMessage(msg, extractText(msg));
await handleMessage(sock, msg);
      }
    });

  } catch (err) {
    console.error("💥 Error in startBot:", err.message);

    if (attempt >= MAX_RECONNECTS) {
      console.error("❌ Too many failures. Exiting.");
      process.exit(1);
    }

    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 60_000);
    console.log(`🔁 Retrying in ${(delay / 1000).toFixed(1)}s...`);
    setTimeout(() => startBot(attempt + 1), delay);
  }
}

startBot();
