import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { useMultiFileAuthState, BufferJSON } from "@whiskeysockets/baileys";
import { USE_MONGO, Models } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// All local sessions live under session/
const SESSION_BASE_DIR = path.join(__dirname, "..", "session");

export default class HybridAuth {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.dir = path.join(SESSION_BASE_DIR, sessionId);
  }

  async init() {
    console.log(`[ HOOPER ] Starting session: "${this.sessionId}"`);

    const localExists = await this._localExists();

    if (!localExists) {
      if (USE_MONGO) {
        console.log(`[ HOOPER ] [${this.sessionId}] Session not found locally — downloading from MongoDB...`);
        try {
          await this._downloadToLocal();
        } catch (err) {
          console.error(`[ EXCEPTION ] [${this.sessionId}] Session download failed: ${err.message}`);
          await fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => {});
        }
        if (await this._localExists()) {
          console.log(`[ HOOPER ] [${this.sessionId}] Session restored from MongoDB ✓`);
        } else {
          console.log(`[ HOOPER ] [${this.sessionId}] No existing session found — QR scan required.`);
          await fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        console.log(`[ HOOPER ] [${this.sessionId}] No existing session found locally — QR scan required.`);
      }
    } else {
      console.log(`[ HOOPER ] [${this.sessionId}] Local session found ✓`);
    }

    await fs.promises.mkdir(this.dir, { recursive: true }).catch(() => {});

    const { state, saveCreds: saveCredsLocal } = await useMultiFileAuthState(this.dir);

    const saveCreds = async () => {
      await saveCredsLocal();
      if (USE_MONGO) {
        await this.pushToMongoDB().catch((err) => console.error(`[ EXCEPTION ] MongoDB session sync error: ${err.message}`));
      }
    };

    const clearState = async () => {
      await this._clearSession();
    };

    return { state, saveCreds, clearState };
  }

  async pushToMongoDB() {
    if (!USE_MONGO) return;
    const localExists = await this._localExists();
    if (!localExists) return;

    let entries;
    try {
      entries = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }

    const files = {};
    for (const entry of entries) {
      const filePath = path.join(this.dir, entry);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isFile()) {
          const content = await fs.promises.readFile(filePath);
          files[entry] = content.toString("base64");
        }
      } catch {}
    }

    if (Object.keys(files).length === 0) return;

    await Models.Session.updateOne(
      { sessionId: this.sessionId },
      { $set: { files, lastSync: new Date() } },
      { upsert: true }
    );
  }

  async _localExists() {
    const credsPath = path.join(this.dir, "creds.json");
    try {
      await fs.promises.access(credsPath);
      return true;
    } catch {
      return false;
    }
  }

  async _downloadToLocal() {
    if (!USE_MONGO) return;
    const doc = await Models.Session.findOne({ sessionId: this.sessionId });
    if (!doc || !doc.files) return;

    await fs.promises.mkdir(this.dir, { recursive: true }).catch(() => {});
    for (const [filename, base64Content] of Object.entries(doc.files)) {
      if (!base64Content) continue;
      const filePath = path.join(this.dir, filename);
      await fs.promises.writeFile(filePath, Buffer.from(base64Content, "base64"));
    }
  }

  async _clearSession() {
    await fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => {});
    if (USE_MONGO) {
      try {
        await Models.Session.deleteOne({ sessionId: this.sessionId });
      } catch {}
    }
    console.log(`[ HOOPER ] Session cleared.`);
  }
}
