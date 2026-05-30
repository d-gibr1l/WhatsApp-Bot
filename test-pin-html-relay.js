import fs from "fs";

const html = fs.readFileSync("pin.html", "utf-8");
const relayMatch = html.match(/<script[^>]*id="__PWS_RELAY_DATA__"[^>]*>([\s\S]*?)<\/script>/);
if (relayMatch) {
    fs.writeFileSync("relay.json", relayMatch[1]);
    console.log("Extracted __PWS_RELAY_DATA__ to relay.json");
} else {
    console.log("No JSON data block found.");
}
