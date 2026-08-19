
const apiKey = '92a2927666msh27b5ac9a8eb8e92p19a116jsnced0f121c0b5';
const url = 'https://youtube.com/shorts/K56LuXCQ0ik?si=apfGp4vzDmIeR337';
const videoId = 'K56LuXCQ0ik';

(async () => {
    try {
        console.log('Testing API 1...');
        const r1 = await fetch('https://all-media-downloader4.p.rapidapi.com/api/youtube/download?id=' + videoId, {
            headers: { 'x-rapidapi-host': 'all-media-downloader4.p.rapidapi.com', 'x-rapidapi-key': apiKey }
        });
        const d1 = await r1.json();
        console.log('API 1 status:', d1.status);
    } catch(e) { console.log('API 1 error:', e.message) }

    try {
        console.log('Testing API 2...');
        const r2 = await fetch('https://social-media-video-downloader.p.rapidapi.com/youtube/v3/video/details?videoId=' + videoId + '&urlAccess=proxied&renderableFormats=720p,highres,360p&getTranscript=false', {
            headers: { 'x-rapidapi-host': 'social-media-video-downloader.p.rapidapi.com', 'x-rapidapi-key': apiKey }
        });
        const d2 = await r2.json();
        const merged = (d2.contents?.[0]?.videos || []).find(v => v.metadata?.has_audio);
        console.log('API 2 merged video url present:', !!merged?.url);
    } catch(e) { console.log('API 2 error:', e.message) }

    try {
        console.log('Testing API 3...');
        const r3 = await fetch('https://youtube-info-download-api.p.rapidapi.com/ajax/download.php?format=720&url=' + encodeURIComponent(url), {
            headers: { 'x-rapidapi-host': 'youtube-info-download-api.p.rapidapi.com', 'x-rapidapi-key': apiKey }
        });
        const d3 = await r3.json();
        console.log('API 3 progress_url present:', !!d3.progress_url);
    } catch(e) { console.log('API 3 error:', e.message) }

    try {
        console.log('Testing API 4...');
        const r4 = await fetch('https://all-in-one-social-media-saver-api.p.rapidapi.com/smvd/get/all?url=' + encodeURIComponent(url), {
            headers: { 'x-rapidapi-host': 'all-in-one-social-media-saver-api.p.rapidapi.com', 'x-rapidapi-key': apiKey }
        });
        console.log('API 4 HTTP status:', r4.status);
    } catch(e) { console.log('API 4 error:', e.message) }
})();

