async function test() {
  const res = await fetch("https://open.spotify.com/track/6VnF7N8Tz1wU4EeeLPR3uC");
  const html = await res.text();
  
  const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
  const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
  const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
  
  console.log("Title:", titleMatch?.[1]);
  console.log("Desc:", descMatch?.[1]);
  console.log("Image:", imgMatch?.[1]);
}
test();
