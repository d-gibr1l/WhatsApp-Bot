import { config } from "dotenv";
config();

// Supabase is used for settings, bans, admins, and reminders (db.js).
// It is NOT required for the WhatsApp auth system — that uses MongoDB.
// Warn if missing but don't crash: the bot will run without Supabase features.
const OPTIONAL_SUPABASE_VARS = ["SUPABASE_URL", "SUPABASE_KEY"];
for (const key of OPTIONAL_SUPABASE_VARS) {
  if (!process.env[key]) {
    console.warn(`⚠️  ${key} is not set — Supabase-backed features (settings, bans, admins) will be unavailable.`);
  }
}

export const SUPABASE_URL   = process.env.SUPABASE_URL;
export const SUPABASE_KEY   = process.env.SUPABASE_KEY;
export const DATABASE_URL   = process.env.DATABASE_URL ?? null; // Postgres connection string for LISTEN/NOTIFY
export const PORT           = parseInt(process.env.PORT || "3000", 10);
export const SESSION_DIR    = "/app/session";
export const MAX_RECONNECTS = 10;
export const BASE_DELAY_MS  = 2000;

// BOT_NUMBER is auto-detected from sock.user.id after QR scan.
// Can still be set via env var for local dev/testing.
// All files import botConfig and read botConfig.BOT_NUMBER so they
// always get the latest value after it's detected.
export const botConfig = {
  BOT_NUMBER: process.env.BOT_NUMBER ?? null,
};
