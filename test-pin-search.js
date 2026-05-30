import fs from "fs";

async function fetchPinterestSearch() {
  const query = "superman";
  
  // Get guest cookie
  const homeRes = await fetch("https://www.pinterest.com/");
  const cookies = homeRes.headers.get("set-cookie");
  
  const endpoint = "https://www.pinterest.com/resource/BaseSearchResource/get/";
  const options = {
    appliedProductFilters: "---",
    auto_correction_disabled: false,
    bookmarks: [""],
    page_size: 5,
    query: query,
    redux_normalize_feed: true,
    rs: "typed",
    scope: "pins",
    source_url: `/search/pins/?q=${query}&rs=typed`,
  };
  
  const urlQuery = new URLSearchParams({
    source_url: options.source_url,
    data: JSON.stringify({ options, context: {} }),
    _: Date.now()
  }).toString();
  
  const url = `${endpoint}?${urlQuery}`;
  console.log("Fetching Search:", url);
  
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "x-pinterest-pws-handler": "www/search/pins/?q=[q]&rs=[rs].js",
      "Cookie": cookies
    }
  });
  
  const data = await res.json();
  fs.writeFileSync("pin_res_search.json", JSON.stringify(data, null, 2));
  console.log("Saved to pin_res_search.json");
}

fetchPinterestSearch().catch(console.error);
