import fs from "fs";

async function fetchPinterest() {
  const realPinId = "888405463999317145"; 
  
  // 1. Get Guest Cookie
  const homeRes = await fetch("https://www.pinterest.com/");
  const cookies = homeRes.headers.get("set-cookie");
  console.log("Guest Cookies:", cookies);
  
  const endpoint = "https://www.pinterest.com/resource/ApiResource/get/";
  const options = {
    url: "/v3/users/me/recent/engaged/pin/stories/",
    data: {
      fields: "pin.description,pin.id,pin.images[236x]",
      pin_preview_count: 1,
    }
  };
  
  const query = new URLSearchParams({
    source_url: `/pin/${realPinId}/`,
    data: JSON.stringify({ options, context: {} }),
    _: Date.now()
  }).toString();
  
  const url = `${endpoint}?${query}`;
  console.log("Fetching Main Pin...");
  
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "x-pinterest-pws-handler": "www/pin/[id].js",
      "Cookie": cookies
    }
  });
  
  const data = await res.json();
  fs.writeFileSync("pin_res_main.json", JSON.stringify(data, null, 2));
  console.log("Saved to pin_res_main.json");
}

fetchPinterest().catch(console.error);
