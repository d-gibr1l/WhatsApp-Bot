import { createClient } from "@supabase/supabase-js";
import { useSupabaseAuthState } from "supabase-baileys";
import { proto, BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";
import { SUPABASE_URL, SUPABASE_KEY, botConfig } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── In-memory key cache ──────────────────────────────────────────────────────
// keys.get → RAM first, Supabase only on miss
// keys.set → RAM immediately + Supabase async (non-blocking)
// This keeps ping at <100ms while still persisting reliably to Supabase

function buildCachedAuthState(state) {
  const keyCache = new Map();

  const cachedKeys = {
    get: async (type, ids) => {
      const result = {};
      const misses = [];

      for (const id of ids) {
        const cacheKey = `${type}-${id}`;
        if (keyCache.has(cacheKey)) {
          result[id] = keyCache.get(cacheKey);
        } else {
          misses.push(id);
        }
      }

      // Only hit Supabase for cache misses
      if (misses.length > 0) {
        const fromDb = await state.keys.get(type, misses);
        for (const id of misses) {
          const val = fromDb[id];
          const cacheKey = `${type}-${id}`;
          keyCache.set(cacheKey, val ?? null);
          result[id] = val;
        }
      }

      return result;
    },

    set: async (data) => {
      // Update RAM immediately so bot never blocks on DB latency
      for (const [category, categoryData] of Object.entries(data)) {
        for (const [id, value] of Object.entries(categoryData)) {
          const cacheKey = `${category}-${id}`;
          if (value) {
            keyCache.set(cacheKey, value);
          } else {
            keyCache.delete(cacheKey);
          }
        }
      }

      // Persist to Supabase with retry — up to 3 attempts
      let attempts = 0;
      const persist = async () => {
        try {
          await state.keys.set(data);
        } catch (err) {
          attempts++;
          if (attempts < 3) {
            setTimeout(persist, 500 * attempts); // 500ms, 1000ms backoff
          } else {
            console.error("❌ Key sync failed after 3 attempts:", err.message);
          }
        }
      };
      persist();
    },
  };

  return {
    creds: state.creds,
    keys:  cachedKeys,
  };
}

// ─── Get auth state — supabase-baileys + RAM cache ────────────────────────────
export async function getAuthState() {
  const sessionId = botConfig.BOT_NUMBER || process.env.BOT_NUMBER || "default";

  const { state, saveCreds, clear, removeCreds } = await useSupabaseAuthState({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    session:     sessionId,
    tableName:   "auth",
  });

  // Wrap with in-memory cache for fast reads
  const cachedState = buildCachedAuthState(state);

  return { state: cachedState, saveCreds };
}

// ─── Clear session ────────────────────────────────────────────────────────────
export async function clearSession() {
  try {
    const sessionId = botConfig.BOT_NUMBER || "default";
    await supabase.from("auth").delete().eq("session", sessionId);
    console.log("🗑️  Session cleared");
  } catch (err) {
    console.error("❌ Failed to clear session:", err.message);
  }
}

// ─── Legacy stubs — kept so index.js imports don't break ─────────────────────
export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === "true") {
    console.log("🆕 FORCE_FRESH_SESSION — clearing all sessions");
    await supabase.from("auth").delete().neq("session", "____never____");
  }
  return true;
}

export async function saveSession() {
  // No-op — supabase-baileys handles persistence automatically
}
