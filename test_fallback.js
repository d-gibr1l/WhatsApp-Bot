
import fetch from "node-fetch";

(async () => {
    console.log("Testing API 3 directly...");
    const url = "https://youtube.com/watch?v=dQw4w9WgXcQ";
    const apiKey = "92a2927666msh27b5ac9a8eb8e92p19a116jsnced0f121c0b5";

    const res3 = await fetch(`https://youtube-info-download-api.p.rapidapi.com/ajax/download.php?format=720&url=${encodeURIComponent(url)}`, {
        headers: { "x-rapidapi-host": "youtube-info-download-api.p.rapidapi.com", "x-rapidapi-key": apiKey }
    });
    
    if (res3.ok) {
        const initial = await res3.json();
        if (initial.progress_url) {
            let success = false;
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const pollRes = await fetch(initial.progress_url);
                const poll = await pollRes.json();
                console.log("API 3 Poll progress:", poll.progress);
                if (poll.download_url || poll.url) {
                    console.log("API 3 SUCCESS! Download URL:", poll.download_url || poll.url);
                    success = true;
                    break;
                }
            }
            if(!success) console.log("API 3 Failed: Poll timed out");
        }
    }
})();

