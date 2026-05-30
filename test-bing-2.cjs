const fs = require('fs');
const params = new URLSearchParams({ q: 'superman pinterest', form: 'HDRSC2' });
fetch('https://www.bing.com/images/search?' + params, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } })
  .then(res => res.text())
  .then(html => {
    const results = [...html.matchAll(/murl&quot;:&quot;(.*?)&quot;/g)].map(m => m[1]);
    console.log(results.slice(0, 10));
  }).catch(e => console.log(e));
