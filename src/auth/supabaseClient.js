import { createClient } from '@supabase/supabase-js';

/**
 * L3 Store — Supabase / PostgreSQL.
 *
 * The source of truth and disaster-recovery layer. All Baileys
 * auth keys are persisted here so a full container replacement
 * (new deploy, OOM kill, Redis eviction) never requires re-linking
 * the WhatsApp QR code.
 *
 * Uses the service_role key to bypass Row Level Security for
 * server-side operations. Never expose this key client-side.
 *
 * FIX: The original code used SUPABASE_SERVICE_KEY which resolves
 * to undefined. The correct env var name exported by the Supabase
 * dashboard is SUPABASE_SERVICE_ROLE_KEY. Using the wrong name
 * silently falls back to anonymous access, breaking all writes.
 *
 * Required table (run once in Supabase SQL editor):
 *
 *   CREATE TABLE IF NOT EXISTS baileys_auth_keys (
 *     session_id  TEXT        NOT NULL,
 *     key_type    TEXT        NOT NULL,
 *     key_id      TEXT        NOT NULL,
 *     value       TEXT        NOT NULL,
 *     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     PRIMARY KEY (session_id, key_type, key_id)
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_baileys_auth_session
 *     ON baileys_auth_keys (session_id);
 */

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY; // FIX: was SUPABASE_SERVICE_KEY

if (!supabaseUrl) throw new Error('SUPABASE_URL is not set');
if (!serviceKey)  throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');

export const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
  db:   { schema: 'public' },
});
