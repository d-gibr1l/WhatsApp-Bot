const fs = require('fs');
const path = require('path');
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) {
      let c = fs.readFileSync(p, 'utf8');
      if (c.includes('import cheerio from "cheerio"')) {
        fs.writeFileSync(p, c.replace('import cheerio from "cheerio"', 'import * as cheerio from "cheerio"'));
      }
    }
  }
}
walk('./node_modules/@myno_21/pinterest-scraper/src/');
console.log('Patched');
