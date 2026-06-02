async function test() {
  const res = await fetch("https://api.song.link/v1-alpha.1/links?url=https://open.spotify.com/track/6VnF7N8Tz1wU4EeeLPR3uC");
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
test();
