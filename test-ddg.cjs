async function searchDDG(query) {
  try {
    const res = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await res.text();
    const vqdMatch = html.match(/vqd=([a-zA-Z0-9_\-]+)/);
    if (!vqdMatch) return console.log('No vqd found');
    const vqd = vqdMatch[1];
    
    const res2 = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const json = await res2.json();
    console.log(json.results.slice(0, 5).map(r => r.image));
  } catch (err) {
    console.error(err);
  }
}
searchDDG('superman site:pinterest.com');
