import spotifyUrlInfo from "spotify-url-info";

const spotify = spotifyUrlInfo(fetch);

async function test() {
  try {
    const data = await spotify.getPreview("https://open.spotify.com/track/6VnF7N8Tz1wU4EeeLPR3uC"); // Example track
    console.log(data);
  } catch (err) {
    console.error(err);
  }
}
test();
