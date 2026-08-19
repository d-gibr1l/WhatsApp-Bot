
const apiKey = '92a2927666msh27b5ac9a8eb8e92p19a116jsnced0f121c0b5';
(async () => {
    const res = await fetch('https://social-media-video-downloader.p.rapidapi.com/youtube/v3/video/details?videoId=K56LuXCQ0ik&urlAccess=proxied&renderableFormats=720p,highres,360p&getTranscript=false', {
      headers: { 'x-rapidapi-host': 'social-media-video-downloader.p.rapidapi.com', 'x-rapidapi-key': apiKey }
    });
    const data = await res.json();
    console.log(JSON.stringify(data.contents[0].videos, null, 2));
})();

