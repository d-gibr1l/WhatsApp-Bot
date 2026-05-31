<div align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="100" height="100" alt="WhatsApp Logo"/>
  <h1>Supercharged WhatsApp Bot</h1>
  <p>A lightning-fast, feature-rich WhatsApp bot built with Baileys and Node.js. Designed for high-performance media downloading, group management, and AI integration.</p>
</div>

---

## 🌟 Key Features

### 🚀 Universal Media Downloader (`!dl`)
The fastest media downloader for WhatsApp, powered by a highly optimized `yt-dlp` backend.
*   **Supported Platforms:** Instagram, TikTok, YouTube, X (Twitter), Reddit, Facebook, and more!
*   **Optimized Delivery:** Bypasses unnecessary FFmpeg remuxing and uses multi-threaded downloading (aria2c) for instant video processing.
*   **Audio Conversion:** Easily download music using the `!mp3` command.

### 🎨 Advanced Sticker Engine (`!sticker`)
Turn anything into a sticker perfectly formatted for WhatsApp.
*   **Static & Animated:** Converts standard images and GIFs/MP4s to WebP automatically.
*   **Bulk Sessions (`!stickers`):** Send a huge bundle of photos or videos and convert them all to stickers in one go using the bulk processor.
*   **Sticker Tools:** Crop stickers (`!stickercrop`), add text (`!stickertext`), extract images (`!toimage`), and customize your pack names (`!packname`).

### 🤖 AI Integration
Powered by Groq's lightning-fast inference API.
*   **Smart Chat (`!ai`):** Chat with the bot using LLaMA3. The bot remembers context and can respond intelligently.
*   **AI Images & Stickers:** Generate images directly from text prompts (`!aiimage` and `!aisticker`).

### 🛡️ Group Management
Keep your group chats clean and organized.
*   **Automated Moderation:** Anti-link protection (`!antilinkon`) and customizable word filters (`!wfilteron`).
*   **Auto-Replies:** Set up custom triggers and responses for your groups (`!autoreply`).
*   **Admin Tools:** Warn users, manage permissions, and broadcast messages easily.

### 🎮 Fun & Image Filters
Spice up the chat with interactive features!
*   **Custom Filters:** Apply the classic GTA `!wasted` filter or the shaking `!triggered` effect to any image!
*   **Memes & Lyrics:** Pull random highly-upvoted memes (`!meme`) or get lyrics for any song (`!lyrics`).
*   **Classics:** `!joke`, `!fact`, `!quote`, `!8ball`, and `!tts` (Text-to-Speech).

---

## 🛠️ Deployment

This bot is fully Dockerized and optimized for continuous deployment platforms like **Koyeb**, **Railway**, or **Render**.

### Prerequisites
*   Node.js v18+
*   FFmpeg (required for video, audio, and sticker processing)
*   yt-dlp (required for media downloading)

### Running Locally

1. **Clone the repository:**
   ```bash
   git clone https://github.com/d-gibr1l/WhatsApp-Bot.git
   cd WhatsApp-Bot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the bot:**
   ```bash
   npm start
   ```

4. **Link your WhatsApp:**
   Scan the QR code printed in the terminal using the "Linked Devices" feature in your WhatsApp app.

---

## ⚙️ Configuration

The bot can be configured using in-chat admin commands without needing to restart the server! 
*   `!setprefix <character>` - Change the bot's command prefix.
*   `!setgroqkey <key>` - Add your Groq API key for AI features.
*   `!setpackname <name>` - Change the default sticker pack name.

---

*Disclaimer: This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or its affiliates. Use at your own risk.*