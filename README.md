<p align="center">
  <a href="https://github.com/d-gibr1l/WhatsApp-Bot">
    <img src="./Assets/hwyb-cid-kagenou-from-the-eminen.png" width="80%">
  </a>
</p>

<h1 align="center">⚡ Hooper MD</h1>

<p align="center">
  <i>An Opensource WhatsApp bot by <a href="https://github.com/d-gibr1l">d-gibr1l</a> & Team Hooper — built with Baileys Multi-Device for maximum features, stability and compatibility.</i>
</p>

<p align="center">
  <a href="https://github.com/d-gibr1l/WhatsApp-Bot/fork">
    <img src="https://img.shields.io/github/forks/d-gibr1l/WhatsApp-Bot?label=Fork&style=social">
  </a>
  &nbsp;
  <a href="https://github.com/d-gibr1l/WhatsApp-Bot/stargazers">
    <img src="https://img.shields.io/github/stars/d-gibr1l/WhatsApp-Bot?style=social">
  </a>
</p>

<p align="center">
  <a href="https://github.com/d-gibr1l/WhatsApp-Bot/actions/workflows/ci.yml">
    <img src="https://github.com/d-gibr1l/WhatsApp-Bot/actions/workflows/ci.yml/badge.svg" alt="CI Build Status">
  </a>
</p>

<p align="center">
  <a href="https://github.com/d-gibr1l">
    <img src="https://img.shields.io/badge/Owner-Team Hooper-white.svg?style=for-the-badge&logo=github" width="170px">
  </a>
  <a href="https://github.com/d-gibr1l/WhatsApp-Bot/blob/main/LICENSE.md">
    <img src="https://img.shields.io/github/license/d-gibr1l/WhatsApp-Bot?color=%231e81b0&style=for-the-badge" width="114px">
  </a>
  <a href="https://github.com/d-gibr1l">
    <img src="https://img.shields.io/badge/Open%20Source-YES-green.svg?style=for-the-badge" width="150px">
  </a>
  <a href="https://github.com/d-gibr1l">
    <img src="https://img.shields.io/badge/Maintained-YES-green.svg?style=for-the-badge" width="143px">
  </a>
</p>

<p align="center">
  <a href="https://cutt.ly/HooperSupportStrict">
    <img src="https://img.shields.io/badge/Join%20Support%20Group-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" width="200px">
  </a>
</p>

---

## 🎀 Key Features at a Glance

| Feature                     | Details                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 🌐 **Web Dashboard**          | Configure the bot in real-time through a beautiful web dashboard UI.                                                                |
| 🤖 **Triple AI**            | ChatGPT · Claude · Gemini — with multi-key pool for rate-limit distribution                                                         |
| 💬 **Chatbot**              | Group chatbot (replies to @mentions) + DM chatbot (toggleable)                                                                      |
| 📥 **Universal Downloader** | TikTok · Instagram · Pinterest · Facebook · Twitter/X · Threads · Videy · Mega · SoundCloud · Spotify · YouTube · Sfile · MediaFire |
| 🎬 **Movie Search**         | Integrated TMDB plugin to search and find movies & TV shows directly in chat.                                                       |
| 🎭 **26 Anime Reactions**   | bite, bonk, hug, kiss, slap, pat, cry... all as animated GIFs                                                                       |
| 🎨 **20 Bot Characters**    | Switch personality: Hooper, Power, Makima, Zero Two, Miku, Rem & 14 more                                                            |
| 🛡️ **Full Moderation**      | Silent ban (user & group), role hierarchy, bot mode (Self/Private/Public), and Advanced Anti-Delete System.                         |
| 👥 **Group Management**     | Promote, demote, tagall, antilink, welcome/goodbye, info, link & more                                                               |
| 🔖 **Sticker Toolkit**      | Make stickers from image/video, meme stickers, quote stickers, emoji mixer                                                          |
| 🔄 **Media Converters**     | Sticker↔Image/GIF/MP4, Video→MP3, Image→PDF, Media→URL, URL→QR                                                                      |
| 🔍 **Search Engine**        | Google, Wikipedia, YouTube, Lyrics, Weather, GitHub, Wallpapers, Ringtones                                                          |
| 🧩 **Live Plugin Store**    | Install/uninstall plugins from URL — no restart needed                                                                              |
| ☁️ **MongoDB Powered**      | All settings persist: bans, mods, modes, chatbot, welcome, characters                                                               |
| 🔧 **FFmpeg Bundled**       | No manual FFmpeg install needed — shipped via `ffmpeg-static`                                                                       |
| 🆔 **Baileys v7 Ready**     | Full LID resolution — owner detection & chatbot @mentions work correctly                                                            |

---

## 🚀 One-Click Deploy

<p align="center">

| Platform    | Deploy                                                                                                                                                                                                                                                                                                                                                                                       | Tutorial                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Repl.it** | <a href="https://repl.it/github/d-gibr1l/WhatsApp-Bot"><img src="https://i.ibb.co/zrB5kMh/deploy-on-repl.jpg" alt="Deploy on Repl.it" height="32"></a>                                                                                                                                                                                                                                       | [▶ Watch](https://youtu.be/R-_DU73UH8Q) |
| **Railway** | <a href="https://railway.app/new/template/Gts2Zx?referralCode=f3gg2m"><img src="https://railway.app/button.svg" alt="Deploy on Railway" height="32"></a>                                                                                                                                                                                                                                     | [▶ Watch](https://youtu.be/Qs6ryWnEtu8) |
| **Render**  | <a href="https://render.com/deploy?repo=https://github.com/d-gibr1l/WhatsApp-Bot"><img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" height="32"></a>                                                                                                                                                                                                   | —                                       |
| **Heroku**  | <a href="https://heroku.com/deploy?template=https://github.com/d-gibr1l/WhatsApp-Bot"><img src="https://www.herokucdn.com/deploy/button.png" alt="Deploy on Heroku" height="32"></a>                                                                                                                                                                                                         | —                                       |

</p>

---

## ⚙️ Environment Variables

> Set these in `.env` (local) or as Environment Variables on your hosting platform.  
> Multiple API keys can be comma-separated — the bot picks one randomly per request.

| Variable              | Description                                                                                   | Required    |
| --------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| `PREFIX`              | Command prefix (e.g. `-`, `.`, `!`)                                                           | ✅          |
| `MODS`                | Owner phone numbers without `+` or spaces, comma-separated (e.g. `9181011xxxxx,9198XXXXXXXX`) | ✅          |
| `MONGODB`             | Your MongoDB connection URL                                                                   | ✅          |
| `SESSION_ID`          | Any random string — acts as the bot session key                                               | ✅          |
| `TENOR_API_KEY`       | Tenor API key(s) for GIF commands, comma-separated                                            | ✅ for GIFs |
| `TMDB_API_KEY`        | The Movie Database API key (for `.movie` command)                                             | Optional    |
| `GEMINI_API`          | Google Gemini API key(s), comma-separated                                                     | Optional    |
| `OPENAI_API`          | OpenAI API key(s) starting with `sk-`, comma-separated                                        | Optional    |
| `CLAUDE_API`          | Anthropic Claude API key(s), comma-separated                                                  | Optional    |
| `PACKNAME`            | Sticker pack name (default: `Hooper Bot`)                                                     | Optional    |
| `AUTHOR`              | Sticker author name (default: `by: Team Hooper`)                                              | Optional    |
| `PORT`                | Server port (default: `10000`)                                                                | Optional    |
| `GC_INTERVAL_MINUTES` | MongoDB garbage collection interval in minutes (default: `5`)                                 | Optional    |
| `WATCHDOG_INTERVAL_SECONDS` | WhatsApp server health-probe interval in seconds (default: `60`)                        | Optional    |
| `MESSAGE_CACHE_TTL_MINUTES` | Anti-delete message retention in minutes (default: `360`, minimum: `30`)                | Optional    |
| `MESSAGE_CACHE_MAX_PER_CHAT` | Maximum anti-delete messages retained per chat (default: `500`, minimum: `50`)         | Optional    |

---

## 📦 Local Installation

**Requirements:** [Node.js](https://nodejs.org/en/download/) · [Git](https://github.com/git-guides/install-git) · libwebp _(Linux only)_

> FFmpeg is **bundled automatically** via `ffmpeg-static` — no manual install needed!

```bash
# 1. Clone and enter the directory
git clone https://github.com/d-gibr1l/WhatsApp-Bot
cd WhatsApp-Bot

# 2. Install dependencies
npm install

# 3. Copy and fill in your config
cp .env.example .env
# → Edit .env with your values

# 4. Start the bot using PM2
npm install -g pm2
pm2 start ecosystem.config.cjs
```

Scan the QR that appears in your browser via **WhatsApp → Linked Devices → Link a device**.

> **Lost your session?** Change `SESSION_ID` to any new random value in `.env` and restart.

---

## 🐧 Android (UserLand) Installation ( Ubultu / Debian / Kali OS )

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y bash git nodejs npm ffmpeg libwebp-dev imagemagick wget curl

git clone https://github.com/d-gibr1l/WhatsApp-Bot
cd WhatsApp-Bot
npm install
npm install -g pm2

cp .env.example .env
# → Edit .env with your values

pm2 start ecosystem.config.cjs
```

**Stop bot:** `pm2 kill` &nbsp;|&nbsp; **Restart:** `pm2 restart Hooper` &nbsp;|&nbsp; **Update session:** edit `SESSION_ID` in `.env`, then `git pull && pm2 restart Hooper`

---

## ✨ Feature Highlights

**Hooper MD** comes packed with a robust set of features to power your groups and DMs. Instead of a massive list of commands, here are the top capabilities you get out-of-the-box:

- 🤖 **Advanced AI Integrations**: Seamlessly chat with Gemini, ChatGPT, and Claude. Built-in multi-key pools ensure you don't hit rate limits, and the AI can remember context for conversational interactions.
- 🛠️ **Group Moderation & Management**: Take full control of your groups. Features include silent bans (users are ignored by the bot), anti-link protection, customizable welcome/goodbye messages, tagging all members, and managing admin roles fluidly.
- 📥 **Universal Downloader**: Simply send a link from TikTok, Instagram, YouTube, X (Twitter), Pinterest, Spotify, Facebook, or SoundCloud, and the bot will instantly recognize and download the media or audio for you.
- 🖼️ **Media & Sticker Toolkit**: Create static, animated, or meme stickers directly from images and videos. Convert media between formats (MP4 to MP3, Image to PDF, Sticker to Video) with ease. Includes built-in Google Emoji Kitchen mixing!
- 🧩 **Live Plugin Architecture**: Expand the bot's functionality without ever shutting it down. Use `-install` to add new commands directly from GitHub gists or URLs on the fly.
- 🔍 **Search & Utilities**: Built-in Google searches, YouTube scraping, lyrics fetcher, HD wallpapers, Pinterest images, GitHub profiling, and real-time weather information.
- 🎭 **Anime Reactions & Characters**: Pick from 20 different anime bot personalities (like Power, Makima, Zero Two) and express yourself with dozens of high-quality animated reaction GIFs (bite, hug, slap, etc.).

> **Tip:** You can view the full list of available commands anytime by typing `-help` in your chat!

---

## 🎭 Bot Characters

Switch the bot's personality and profile picture with `-setchar <ID>`. Use `-charlist` to see all.

| ID  | Character     | Series                 | ID  | Character    | Series            |
| --- | ------------- | ---------------------- | --- | ------------ | ----------------- |
| 0   | **Hooper MD** | Default                | 10  | **Mizuhara** | Rent-A-Girlfriend |
| 1   | **Power**     | Chainsaw Man           | 11  | **Rem**      | Re:Zero           |
| 2   | **Makima**    | Chainsaw Man           | 12  | **Sumi**     | Rent-A-Girlfriend |
| 3   | **Denji**     | Chainsaw Man           | 13  | **Kaguya**   | Kaguya-sama       |
| 4   | **Zero Two**  | Darling in the FranXX  | 14  | **Yumeko**   | Kakegurui         |
| 5   | **Chika**     | Kaguya-sama            | 15  | **Kurumi**   | Date A Live       |
| 6   | **Miku**      | Vocaloid               | 16  | **Mai**      | Bunny Girl Senpai |
| 7   | **Marin**     | My Dress-Up Darling    | 17  | **Yor**      | Spy x Family      |
| 8   | **Ayanokoji** | Classroom of the Elite | 18  | **Shinbou**  | Various           |
| 9   | **Ruka**      | Rent-A-Girlfriend      | 19  | **Eiko**     | Various           |

---

## 💫 Dependencies

| Package                                                                    | Purpose                              |
| -------------------------------------------------------------------------- | ------------------------------------ |
| [WhiskeySockets Baileys v7](https://github.com/WhiskeySockets/Baileys)     | WhatsApp Multi-Device engine         |
| [MongoDB](https://www.mongodb.com/)                                        | Database for all persistent settings |
| [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static)               | Bundled FFmpeg — no manual install   |
| [wa-sticker-formatter](https://www.npmjs.com/package/wa-sticker-formatter) | Sticker creation and conversion      |
| [@google/genai](https://www.npmjs.com/package/@google/genai)               | Official Google Gemini AI SDK        |
| [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk)       | Official Anthropic Claude AI SDK     |
| [openai](https://www.npmjs.com/package/openai)                             | Official OpenAI SDK                  |

---

## 〽️ Why Hooper?

- **100% Open Source** — MIT license, fork and modify freely.
- **300+ Commands** across all plugins, plus a live plugin store for extending without restart.
- **Triple AI** (ChatGPT + Claude + Gemini) built-in with multi-key pools for rate-limit resilience.
- **Universal 13-Platform Downloader** — one command, any link.
- **Silent Banning** — banned users and groups receive zero response; bot acts as if it doesn't exist.
- **No local session storage** — session is stored in MongoDB for privacy and security.
- **Platform-agnostic** — works on Railway, Heroku, Koyeb, Render, Docker, pm2, and local.
- **FFmpeg bundled** — reactions and sticker conversions work out of the box, everywhere.

---

## ⚠️ Warning

- This bot is **not made by WhatsApp Inc.** — overuse may result in account ban.
- Support is provided **only for deployment/setup**, not for custom development.
- Made for **Educational / Fun / Group Management** purposes only. Team Hooper is not responsible for misuse.

---

## 📛 Legal Disclaimer

- Use your **own MongoDB URL** for privacy and security.
- Heavy modifications are at your own risk — we cannot support every custom fork.
- We are not responsible for harm caused by individuals running this bot in groups.
