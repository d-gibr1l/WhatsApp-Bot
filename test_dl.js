
import { downloadWithYtDlp } from './src/downloader.js';

(async () => {
    try {
        console.log('Starting test...');
        const res = await downloadWithYtDlp('https://youtube.com/shorts/K56LuXCQ0ik?si=apfGp4vzDmIeR337', false, '720');
        console.log('Success:', res);
    } catch (e) {
        console.error('Test Failed:', e.message);
    }
})();

