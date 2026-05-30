const fs = require('fs');
const params = new URLSearchParams({ q: 'superman site:pinterest.com', form: 'HDRSC2' });
fetch('https://www.bing.com/images/search?' + params, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  .then(res => res.text())
  .then(html => {
    fs.writeFileSync('bing.html', html);
    const results = [...html.matchAll(/murl&quot;:&quot;(.*?)&quot;/g)].map(m => m[1]);
    console.log(results.slice(0, 5));
  });
