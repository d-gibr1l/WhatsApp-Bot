import fs from "fs/promises";
import path from "path";
import os from "os";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const archiver = require("archiver");
const unzipper = require("unzipper");
import { createReadStream, createWriteStream } from "fs";
import { supabase } from "../db.js";
import { SESSION_DIR, botConfig, SUPABASE_URL, SUPABASE_KEY } from "../config.js";

const BUCKET_NAME = "sessions";
const MAX_ZIP_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB safety limit
const UPLOAD_TIMEOUT_MS = 30_000; // 30s timeout for shutdown uploads
let isSyncing = false;
let syncInterval = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a stable session ID.
 * Prefers the env var (always available), falls back to runtime-detected number.
 */
function getSessionId() {
  return process.env.BOT_NUMBER || botConfig.BOT_NUMBER || "default_session";
}

/**
 * Zips the local session directory.
 * Uses compression level 1 (fast) — session files are small,
 * speed matters more than a few KB of savings.
 */
function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 1 } });
    const stream = createWriteStream(outPath);

    stream.on("error", (err) => reject(err));
    stream.on("close", () => resolve());

    archive.on("error", (err) => reject(err));
    archive.directory(sourceDir, false);
    archive.pipe(stream);
    archive.finalize();
  });
}

// ─── Download ─────────────────────────────────────────────────────────────────

/**
 * Downloads and extracts the session zip from Supabase Storage.
 * The 'sessions' bucket must already exist (created manually in Dashboard).
 */
export async function downloadSessionFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("[SupabaseSync] Supabase not configured. Skipping session download.");
    return false;
  }

  const sessionId = getSessionId();
  const zipName = `${sessionId}.zip`;

  console.log(`[SupabaseSync] Looking for session backup '${zipName}'...`);

  const { data, error } = await supabase.storage.from(BUCKET_NAME).download(zipName);

  if (error) {
    console.log(`[SupabaseSync] No backup found or download failed (${error.message}). Starting fresh.`);
    return false;
  }

  const tmpZipPath = path.join(os.tmpdir(), `dl_${zipName}`);

  try {
    await fs.writeFile(tmpZipPath, Buffer.from(await data.arrayBuffer()));

    // Ensure the session directory is empty before extracting
    await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(SESSION_DIR, { recursive: true });

    // Extract
    await new Promise((resolve, reject) => {
      createReadStream(tmpZipPath)
        .pipe(unzipper.Extract({ path: SESSION_DIR }))
        .on("close", resolve)
        .on("error", reject);
    });

    // ── Integrity check ──────────────────────────────────────────────────
    // Verify creds.json exists after extraction. If it doesn't, the backup
    // is corrupt and would cause Baileys to crash with BadMAC errors.
    try {
      await fs.access(path.join(SESSION_DIR, "creds.json"));
    } catch {
      console.error("[SupabaseSync] Backup is corrupt (missing creds.json). Wiping and starting fresh.");
      await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(SESSION_DIR, { recursive: true });
      return false;
    }

    console.log("[SupabaseSync] Session backup downloaded and extracted successfully.");
    return true;
  } catch (err) {
    console.error("[SupabaseSync] Failed to extract session backup:", err.message);
    return false;
  } finally {
    await fs.unlink(tmpZipPath).catch(() => {});
  }
}

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * Zips the local session and uploads it to Supabase Storage.
 * Skips if another sync is in progress, directory is empty, or zip exceeds size limit.
 */
export async function uploadSessionToSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY || isSyncing) return;
  isSyncing = true;

  const sessionId = getSessionId();
  const zipName = `${sessionId}.zip`;
  const tmpZipPath = path.join(os.tmpdir(), `ul_${zipName}`);

  try {
    // Verify session dir exists and has files
    const files = await fs.readdir(SESSION_DIR).catch(() => []);
    if (files.length === 0) return;

    await zipDirectory(SESSION_DIR, tmpZipPath);

    // Size guard — prevent OOM on unexpectedly large sessions
    const stat = await fs.stat(tmpZipPath);
    if (stat.size > MAX_ZIP_SIZE_BYTES) {
      console.warn(`[SupabaseSync] Session zip too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Skipping upload.`);
      return;
    }

    const fileBuffer = await fs.readFile(tmpZipPath);

    const { error } = await supabase.storage.from(BUCKET_NAME).upload(zipName, fileBuffer, {
      upsert: true,
      contentType: "application/zip"
    });

    if (error) {
      console.error("[SupabaseSync] Upload failed:", error.message);
    } else {
      console.log(`[SupabaseSync] Session backup '${zipName}' updated successfully.`);
    }
  } catch (err) {
    console.error("[SupabaseSync] Sync error:", err.message);
  } finally {
    await fs.unlink(tmpZipPath).catch(() => {});
    isSyncing = false;
  }
}

/**
 * Upload with a timeout — used during graceful shutdown so Koyeb
 * doesn't force-kill the process while we're mid-upload.
 */
export function uploadSessionWithTimeout(timeoutMs = UPLOAD_TIMEOUT_MS) {
  return Promise.race([
    uploadSessionToSupabase(),
    new Promise((resolve) => setTimeout(() => {
      console.warn(`[SupabaseSync] Upload timed out after ${timeoutMs / 1000}s during shutdown.`);
      resolve();
    }, timeoutMs)),
  ]);
}

// ─── Sync lifecycle ───────────────────────────────────────────────────────────

/**
 * Starts the periodic sync task.
 * Also triggers an immediate upload 30s after being called (upload-on-connect).
 */
export function startSessionSyncTask(intervalMs = 300_000) { // 5 minutes default
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  if (syncInterval) clearInterval(syncInterval);

  console.log(`[SupabaseSync] Starting periodic sync every ${intervalMs / 1000}s`);

  // Immediate backup 30s after connection — catches session state early
  // so a quick Koyeb restart doesn't lose the session.
  setTimeout(() => {
    uploadSessionToSupabase().catch((err) =>
      console.error("[SupabaseSync] Initial upload failed:", err.message)
    );
  }, 30_000);

  syncInterval = setInterval(() => {
    uploadSessionToSupabase().catch(() => {});
  }, intervalMs);
}

/**
 * Stops the periodic sync task.
 */
export function stopSessionSyncTask() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    console.log("[SupabaseSync] Periodic sync stopped.");
  }
}

// ─── Session wipe ─────────────────────────────────────────────────────────────

/**
 * Wipes the session completely from local disk and Supabase.
 */
export async function clearSession() {
  console.log("[SupabaseSync] Wiping session completely.");
  stopSessionSyncTask();

  await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});

  if (SUPABASE_URL && SUPABASE_KEY) {
    const sessionId = getSessionId();
    const zipName = `${sessionId}.zip`;
    await supabase.storage.from(BUCKET_NAME).remove([zipName]).catch(() => {});
  }
}

