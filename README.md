# Multi-Session WhatsApp Baileys API with Redis Persistence

A robust, production-ready WhatsApp session manager using `@whiskeysockets/baileys` and Redis (Upstash compatible) for persistence.

## Features
- **Highly Stable:** Anti "bad mac" errors protection with atomic mutex updates.
- **Persistent Auth:** All Baileys signals and creds are safely stored in Redis.
- **Koyeb Ready:** Optimized for serverless and cloud setups with automatic session recovery on startup.
- **Auto Reconnect:** Intelligent exponential backoff reconnect strategy.
- **Webhook Integration:** Dispatch WhatsApp events to external APIs.
- **Health Monitoring:** Actively tracks frozen sockets and reconnect loops.

## Requirements
- Node.js >= 18
- Redis Database (Upstash Redis highly recommended)

## Installation

1. Clone and install dependencies:
```bash
npm install
```

2. Copy environment file:
```bash
cp .env.example .env
```

3. Update `.env` with your Upstash `REDIS_URL`.

## Upstash Redis Setup Guide
1. Go to [Upstash Console](https://console.upstash.com/).
2. Create a new Redis Database.
3. Scroll down to the "Connect to your database" section.
4. Copy the "Node.js (ioredis)" URL snippet (starts with `redis://...`).
5. Paste it into your `.env` file under `REDIS_URL`.

## Local Development (Docker)
Run the stack using docker-compose:
```bash
docker-compose up --build
```

## Koyeb Deployment Guide
1. Push your repository to GitHub.
2. Go to the [Koyeb Dashboard](https://app.koyeb.com/) and click **Create Service**.
3. Select **GitHub** and choose your repository.
4. Set the **Builder** to `Dockerfile`.
5. Under **Environment variables**, add:
   - `PORT`: `3000`
   - `REDIS_URL`: `<your-upstash-redis-url>`
   - `API_KEY`: `<your-secure-secret>`
6. Deploy the service. Koyeb will automatically build and start the application. When Koyeb redeploys, active sessions will be cleanly recovered from Upstash Redis.

## API Usage Example

Assuming `PORT=3000` and `API_KEY=my_secret`.

### 1. Create a New Session
```bash
curl -X POST http://localhost:3000/session/create \
  -H "x-api-key: my_secret" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "test-session-1"}'
```
*Note: The response will include a `qr` base64 string if login is required.*

### 2. Check Session Status
```bash
curl http://localhost:3000/session/test-session-1/status \
  -H "x-api-key: my_secret"
```

### 3. List All Sessions
```bash
curl http://localhost:3000/sessions \
  -H "x-api-key: my_secret"
```

### 4. Force Reconnect Session
```bash
curl -X POST http://localhost:3000/session/test-session-1/reconnect \
  -H "x-api-key: my_secret"
```

### 5. Delete Session
```bash
curl -X DELETE http://localhost:3000/session/test-session-1 \
  -H "x-api-key: my_secret"
```
