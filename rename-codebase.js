import fs from "fs";
import path from "path";

const targetDir = "C:\\Users\\domin\\Desktop\\my-whatsapp-bot-main";
const ignoreDirs = ["node_modules", ".git", ".next", "build", "dist", ".replit", "Frontend", "System\\Cache"];
const exts = [".js", ".json", ".txt", ".md", ".env", ".env.example", ".sh", ".cjs", ".yaml", ".yml"];

function walk(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (!ignoreDirs.includes(file)) walk(fullPath);
    } else {
      const ext = path.extname(fullPath);
      if (exts.includes(ext) || file === "Procfile" || file === "Dockerfile") {
        let content = fs.readFileSync(fullPath, "utf-8");
        const original = content;
        
        content = content.replace(/Hooper/g, "Hooper");
        content = content.replace(/HOOPER/g, "HOOPER");
        content = content.replace(/hooper/g, "hooper");
        
        if (content !== original) {
          fs.writeFileSync(fullPath, content, "utf-8");
          console.log(`Updated ${fullPath}`);
        }
      }
    }
  }
}

walk(targetDir);
console.log("Codebase replacement complete.");
