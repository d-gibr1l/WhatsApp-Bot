import { createClient } from "@supabase/supabase-js";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { gzipSync, gunzipSync } from "zlib";
import { SUPABASE_URL, SUPABASE_KEY, botConfig } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── In-memory session store ───────────────────────────────────────────────────
// Everything lives here — no disk reads/writes at all
let SESSION = {
  creds: null,
  keys:  {}
};

// ─── Compression helpers ──────────────────────────────────────────────────────
function compress(obj) {
  return gzipSync(JSON.stringify(obj, BufferJSON.replacer)).toString("base64");
}

function decompress(str) {
  return JSON.parse(gunzipSync(Buffer.from(str, "base64")).toString(), BufferJSON.reviver);
}

// ─── Load from Supabase into RAM ──────────────────────────────────────────────
export async function loadSession() {
  try {
    // Try known number first
    if (botConfig.BOT_NUMBER) {
      const { data } = await supabase
        .from("sessions")
        .select("session, number")
        .eq("number", botConfig.BOT_NUMBER)
        .single();
      if (data?.session) {
        SESSION = decompress(data.session);
        console.log(`📱 Session loaded for: ${botConfig.BOT_NUMBER}`);
        return true;
      }
    }

    // Fallback — grab any saved session
    const { data } = await supabase
      .from("sessions")
      .select("session, number")
      .limit(1)
      .single();

    if (data?.session) {
      SESSION = decompress(data.session);
      if (data.number && !botConfig.BOT_NUMBER) {
        botConfig.BOT_NUMBER = data.number;
        console.log(`📱 Bot number restored from session: ${data.number}`);
      }
      return true;
    }

    console.log("🆕 No saved session — fresh start, waiting for QR scan");
    return false;
  } catch (err) {
    console.log("🆕 No saved session — fresh start");
    return false;
  }
}

// ─── Save RAM → Supabase (debounced externally) ───────────────────────────────
export async function saveSession() {
  try {
    if (!botConfig.BOT_NUMBER) return;
    const compressed = compress(SESSION);
    const { error } = await supabase
      .from("sessions")
      .upsert(
        { number: botConfig.BOT_NUMBER, session: compressed },
        { onConflict: "number" }
      );
    if (error) console.error("❌ Failed to save session:", error.message);
  } catch (err) {
    console.error("❌ Unexpected error saving session:", err.message);
  }
}

// ─── Clear session ────────────────────────────────────────────────────────────
export async function clearSession() {
  SESSION = { creds: null, keys: {} };
  try {
    if (botConfig.BOT_NUMBER) {
      await supabase.from("sessions").delete().eq("number", botConfig.BOT_NUMBER);
    }
    console.log("🗑️  Session cleared");
  } catch (err) {
    console.error("❌ Failed to clear session:", err.message);
  }
}

// ─── Custom in-memory auth state (replaces useMultiFileAuthState) ─────────────
export function useMemoryAuthState() {
  // Fresh creds if none saved
  if (!SESSION.creds) {
    SESSION.creds = initAuthCreds();
  }

  const state = {
    creds: SESSION.creds,

    keys: {
      get(type, ids) {
        const data = {};
        for (const id of ids) {
          const val = SESSION.keys?.[type]?.[id];
          if (val !== undefined) data[id] = val;
        }
        return data;
      },

      set(data) {
        for (const type in data) {
          if (!SESSION.keys[type]) SESSION.keys[type] = {};
          for (const id in data[type]) {
            if (data[type][id] === null) {
              delete SESSION.keys[type][id];
            } else {
              SESSION.keys[type][id] = data[type][id];
            }
          }
        }
      }
    }
  };

  const saveCreds = () => {
    SESSION.creds = state.creds;
  };

  return { state, saveCreds };
}
