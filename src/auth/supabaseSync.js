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
let isSyncing = false;
let syncInterval = null;

/**
 * Ensures the bucket exists in Supabase.
 */
async function ensureBucket() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const { error } = await supabase.storage.getBucket(BUCKET_NAME);
  if (error) {
    console.log(`[SupabaseSync] Creating bucket '${BUCKET_NAME}'...`);
    const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
      public: false,
    });
    if (createError && !createError.message.includes("already exists")) {
      console.error(`[SupabaseSync] Failed to create bucket:`, createError.message);
    }
  }
}

/**
 * Zips the local session directory.
 */
function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = createWriteStream(outPath);

    archive
      .directory(sourceDir, false)
      .on("error", (err) => reject(err))
      .pipe(stream);

    stream.on("close", () => resolve());
    archive.finalize();
  });
}

/**
 * Downloads and extracts the session zip from Supabase.
 */
export async function downloadSessionFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("[SupabaseSync] Supabase not configured. Skipping session download.");
    return false;
  }

  await ensureBucket();
  const sessionId = botConfig.BOT_NUMBER || process.env.BOT_NUMBER || "default_session";
  const zipName = `${sessionId}.zip`;
  
  console.log(`[SupabaseSync] Looking for session backup '${zipName}'...`);
  
  const { data, error } = await supabase.storage.from(BUCKET_NAME).download(zipName);
  
  if (error) {
    console.log(`[SupabaseSync] No backup found or download failed (${error.message}). Starting fresh.`);
    return false;
  }

  const tmpZipPath = path.join(os.tmpdir(), zipName);
  
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
    
    console.log("[SupabaseSync] Session backup downloaded and extracted successfully.");
    await fs.unlink(tmpZipPath).catch(() => {});
    return true;
  } catch (err) {
    console.error("[SupabaseSync] Failed to extract session backup:", err.message);
    return false;
  }
}

/**
 * Zips the local session and uploads it to Supabase.
 */
export async function uploadSessionToSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY || isSyncing) return;
  isSyncing = true;
  
  try {
    await ensureBucket();
    const sessionId = botConfig.BOT_NUMBER || process.env.BOT_NUMBER || "default_session";
    const zipName = `${sessionId}.zip`;
    const tmpZipPath = path.join(os.tmpdir(), zipName);

    // Verify session dir exists and has files
    try {
      const files = await fs.readdir(SESSION_DIR);
      if (files.length === 0) throw new Error("empty");
    } catch {
      isSyncing = false;
      return; // Nothing to backup
    }

    await zipDirectory(SESSION_DIR, tmpZipPath);
    
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
    
    await fs.unlink(tmpZipPath).catch(() => {});
  } catch (err) {
    console.error("[SupabaseSync] Sync error:", err.message);
  } finally {
    isSyncing = false;
  }
}

/**
 * Starts the periodic sync task.
 */
export function startSessionSyncTask(intervalMs = 300000) { // 5 minutes default
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  if (syncInterval) clearInterval(syncInterval);
  
  console.log(`[SupabaseSync] Starting periodic sync every ${intervalMs / 1000}s`);
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

/**
 * Wipes the session completely from local disk and Supabase.
 */
export async function clearSession() {
  console.log("[SupabaseSync] Wiping session completely.");
  stopSessionSyncTask();
  
  await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
  
  if (SUPABASE_URL && SUPABASE_KEY) {
    const sessionId = botConfig.BOT_NUMBER || process.env.BOT_NUMBER || "default_session";
    const zipName = `${sessionId}.zip`;
    await supabase.storage.from(BUCKET_NAME).remove([zipName]).catch(() => {});
  }
}
