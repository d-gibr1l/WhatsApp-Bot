import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename) + "/src/commands";

const files = fs.readdirSync(__dirname).filter(
  (file) => file.endsWith(".js") && file !== "registry.js" && file !== "helpers.js"
);

(async () => {
  for (const file of files) {
    try {
      console.log("Importing", file, "...");
      await import(`file://${__dirname}/${file}`);
      console.log("Imported", file);
    } catch (err) {
      console.error(`Failed to load ${file}:`, err);
    }
  }
  console.log("Done!");
})();
