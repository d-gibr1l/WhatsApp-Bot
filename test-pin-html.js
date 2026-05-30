import fs from "fs";

async function fetchPinterestHtml() {
  const realPinId = "888405463999317145"; 
  const url = `https://www.pinterest.com/pin/${realPinId}/`;
  
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }
  });
  
  const html = await res.text();
  fs.writeFileSync("pin.html", html);
  console.log("Saved HTML. Length:", html.length);
  
  // Try to find the __PWS_DATA__ script block
  const scriptMatch = html.match(/<script[^>]*id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (scriptMatch) {
    fs.writeFileSync("pin_data.json", scriptMatch[1]);
    console.log("Extracted __PWS_DATA__ to pin_data.json");
  } else {
    // Try Relay data
    const relayMatch = html.match(/<script[^>]*id="__PWS_RELAY_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (relayMatch) {
        fs.writeFileSync("pin_data.json", relayMatch[1]);
        console.log("Extracted __PWS_RELAY_DATA__ to pin_data.json");
    } else {
        console.log("No JSON data block found.");
    }
  }
}

fetchPinterestHtml().catch(console.error);
