async function searchGoogleImages(query) {
  try {
    const res = await fetch(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
      }
    });
    const html = await res.text();
    // Google images JSON data is inside <script> tags. 
    // We can extract original image URLs using regex matching the JSON structure.
    // e.g. ["https://example.com/image.jpg", 800, 600]
    let urls = [];
    const regex = /\["([^"]+)",\d+,\d+\]/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      let url = match[1];
      // Google escapes unicode \u003d etc
      url = url.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
      if (url.startsWith('http') && !url.includes('gstatic.com')) {
        urls.push(url);
      }
    }
    console.log(urls.slice(0, 5));
  } catch (err) {
    console.error(err);
  }
}
searchGoogleImages('superman site:pinterest.com');
