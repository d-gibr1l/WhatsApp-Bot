import Spotify from "spotifydl-core";

const spotify = new Spotify({
  clientId: "acc6302297e040aeb6e4ac1fbdfd62c3",
  clientSecret: "0e8439a1280a43aba9a5bc0a16f3f009",
});

async function test() {
  try {
    const data = await spotify.getTrack("https://open.spotify.com/track/6VnF7N8Tz1wU4EeeLPR3uC");
    console.log(data);
  } catch (err) {
    console.error(err);
  }
}
test();
