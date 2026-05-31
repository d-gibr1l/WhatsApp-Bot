<div align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="100" height="100" alt="WhatsApp Logo"/>
  <h1>Gib's WhatsApp Bot</h1>
  <p>A lightning-fast, feature-rich WhatsApp bot built with Baileys and Node.js.</p>
</div>

---

## 🌟 Features
*   **Media Downloader (`!dl`):** Lightning-fast downloads from Instagram, TikTok, YouTube, X, Reddit, and more via highly-optimized `yt-dlp`.
*   **Sticker Engine (`!sticker`):** Convert images, GIFs, and MP4s into WhatsApp stickers. Supports bulk conversion (`!stickers`), cropping, and custom packs.
*   **AI Integration (`!ai`):** Smart chat and AI image generation powered by Groq's ultrafast LLaMA3.
*   **Group Management:** Anti-link protection, word filters, warnings, and custom auto-replies.
*   **Fun & Games:** Meme scraper, song lyrics, text-to-speech, and custom image filters (`!wasted`, `!triggered`).

## 🛠️ Quick Start

**Prerequisites:** Node.js v18+, FFmpeg, and yt-dlp.

```bash
git clone https://github.com/d-gibr1l/WhatsApp-Bot.git
cd WhatsApp-Bot
npm install
npm start
```
*Scan the QR code in your terminal using WhatsApp's "Linked Devices" feature.*

## ⚙️ In-Chat Configuration
Once linked, you can configure the bot directly via WhatsApp:
*   `!setprefix <character>` - Change the bot's prefix.
*   `!setgroqkey <key>` - Add your Groq API key for AI.
*   `!setpackname <name>` - Customize sticker pack names.