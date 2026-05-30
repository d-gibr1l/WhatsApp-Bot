fetch('https://www.pinterest.com/search/pins/?q=superman', { headers: { 'User-Agent': 'Mozilla/5.0' } })
  .then(res => res.text())
  .then(html => {
    const urls = [...html.matchAll(/https:\/\/i\.pinimg\.com\/[a-zA-Z0-9_\/-]+\.jpg/g)].map(m => m[0]);
    console.log(urls.slice(0, 10));
  });
