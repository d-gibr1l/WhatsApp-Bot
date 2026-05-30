async function getPinterest(query) {
  try {
    const res = await fetch(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const html = await res.text();
    
    // Pinterest stores the initial state in a JSON script tag:
    // <script id="__PWS_DATA__" type="application/json">...</script>
    const match = html.match(/<script id="__PWS_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return console.log('No PWS_DATA found');
    
    const data = JSON.parse(match[1]);
    
    // Traverse the deeply nested JSON to find images
    // The structure changes, but we can just recursively search for ".jpg" URLs that look like pinimg.com
    let urls = [];
    const jsonString = JSON.stringify(data);
    const regex = /https:\/\/i\.pinimg\.com\/[0-9a-zA-Z]+\/[0-9a-f\/]+\.jpg/g;
    let m;
    while ((m = regex.exec(jsonString)) !== null) {
      if (!urls.includes(m[0])) urls.push(m[0]);
    }
    
    // Filter out thumbnails (usually small resolution folders like 75x75, 236x, 474x)
    // Keep 736x or originals
    urls = urls.filter(u => u.includes('/736x/') || u.includes('/originals/'));
    
    console.log(urls.slice(0, 5));
  } catch (err) {
    console.error(err);
  }
}
getPinterest('superman');
