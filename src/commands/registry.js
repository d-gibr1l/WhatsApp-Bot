import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const commands = {};

const files = fs.readdirSync(__dirname).filter(
  (file) => file.endsWith(".js") && file !== "registry.js" && file !== "helpers.js"
);

for (const file of files) {
  try {
    const module = await import(`./${file}`);
    for (const key of Object.keys(module)) {
      if (key.endsWith("Commands") && typeof module[key] === "object") {
        Object.assign(commands, module[key]);
      }
    }
  } catch (err) {
    console.error(`❌ Failed to load commands from ${file}:`, err);
  }
}

export { replyMsg, isAdmin } from "./helpers.js";
