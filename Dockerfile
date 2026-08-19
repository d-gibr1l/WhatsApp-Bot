FROM node:24.11.1-alpine AS deps
RUN apk upgrade --no-cache && \
    apk add --no-cache python3 make g++ gcc
WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev --legacy-peer-deps

FROM node:24.11.1-alpine
RUN apk upgrade --no-cache && \
    apk add --no-cache ffmpeg imagemagick python3 py3-pip curl unzip bash aria2 && \
    npm install -g pm2 && \
    pip install --break-system-packages yt-dlp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 10000
CMD ["pm2-runtime", "ecosystem.config.cjs"]
