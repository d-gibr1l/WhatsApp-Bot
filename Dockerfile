FROM node:20-slim

# Install ffmpeg and libwebp for sticker conversion
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libwebp-dev \
  python3 \
  python3-pip \
  curl \
  libimage-exiftool-perl \
  qrencode \
  zbar-tools \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --break-system-packages bgutil-ytdlp-pot-provider

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN useradd -r -u 999 botuser && chown -R botuser /app
USER botuser

ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
