async function test() {
  const query = 'superman';
  const url = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=/search/pins/?q=${query}&data={"options":{"isPrefetch":false,"query":"${query}","scope":"pins","no_fetch_context_on_resource":false},"context":{}}`;
  
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const json = await res.json();
  const results = json.resource_response.data.results;
  const urls = results.map(r => r.images.orig.url);
  console.log(urls.slice(0, 5));
}
test();
