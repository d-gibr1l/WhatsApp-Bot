import ffmpeg from 'ffmpeg-static';
import { execSync } from 'child_process';

const input = String.raw`C:\Users\domin\Downloads\bankai.mp4`;
const output = String.raw`C:\Users\domin\Desktop\my-whatsapp-bot-main\Assets\help_gif.mp4`;

console.log(`Using ffmpeg: ${ffmpeg}`);
execSync(`"${ffmpeg}" -i "${input}" -an -vf "scale=640:-1" -r 15 -c:v libx264 -crf 28 -preset veryslow -pix_fmt yuv420p -y "${output}"`, { stdio: 'inherit' });
