async function test() {
  const query = "faded alan walker";
  const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=1&entity=song`);
  const data = await res.json();
  if (data.results && data.results.length > 0) {
    const track = data.results[0];
    console.log("Title:", track.trackName);
    console.log("Artist:", track.artistName);
    console.log("Album:", track.collectionName);
    console.log("Cover:", track.artworkUrl100.replace('100x100bb', '1000x1000bb'));
  } else {
    console.log("Not found");
  }
}
test();
