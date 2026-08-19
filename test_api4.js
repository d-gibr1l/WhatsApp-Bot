
const apiKey = '92a2927666msh27b5ac9a8eb8e92p19a116jsnced0f121c0b5';
(async () => {
    const res = await fetch('https://all-in-one-social-media-saver-api.p.rapidapi.com/smvd/get/all?url=https://youtube.com/shorts/K56LuXCQ0ik', {
      headers: { 'x-rapidapi-host': 'all-in-one-social-media-saver-api.p.rapidapi.com', 'x-rapidapi-key': apiKey }
    });
    console.log(res.status);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
})();

