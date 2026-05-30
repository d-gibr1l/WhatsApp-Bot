import fs from "fs";
const html = fs.readFileSync("pin.html", "utf-8");

const mp4s = html.match(/https:\/\/[a-zA-Z0-9.\-_]+\.mp4/g);
console.log('MP4s:', mp4s ? [...new Set(mp4s)] : 'None');

const origs = html.match(/https:\/\/i\.pinimg\.com\/originals\/[a-zA-Z0-9.\-_]+\.(jpg|png|jpeg)/g);
console.log('Originals:', origs ? [...new Set(origs)] : 'None');
