# Production WhatsApp Session Management System

A highly stable, scalable multi-session WhatsApp management API built with Node.js, Express, Baileys, and Upstash-compatible Redis. Designed explicitly for serverless/cloud environments like Koyeb.

## Features

- **Multi-session support**: Manage multiple WhatsApp accounts from a single API.
- **Redis Persistence**: Auth state (creds and signal keys) is persisted to Redis, enabling seamless restarts and scaling.
- **Anti Bad-MAC System**: Utilizes `async-mutex` and payload compression to ensure atomic, sequential Redis writes, preventing auth corruption and Bad MAC errors.
- **Auto Recovery**: Automatically restores all active sessions from Redis upon server startup.
- **Smart Reconnects**: Exponential backoff strategy for disconnects, preventing reconnect storms and temporary IP bans.
- **Graceful Shutdown**: Intercepts `SIGTERM` and `SIGINT` to safely close sockets and flush pending Redis writes.

## Prerequisites
- Node.js >= 18
- Redis Database (Upstash highly recommended)

## Installation

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment variables:
   ```bash
   cp .env.example .env
   ```
3. Update `.env` with your Redis URL and desired API Key.

## Running the Server

### Local Development
```bash
npm start
```

### Docker
```bash
docker-compose up -d
```

## API Endpoints

*Note: If `API_KEY` is set in your `.env`, all requests must include `x-api-key: your_key` in the headers, or `?api_key=your_key` in the URL query.*

### `POST /session/create`
Initializes a new session or returns the QR code for an existing one.
- **Body**: `{ "sessionId": "my_user_1" }`
- **Returns**: `{ "sessionId": "my_user_1", "status": "qr_required", "qr": "data:image/png;base64,..." }`

### `GET /session/:id/status`
Get the connection status of a specific session.
- **Returns**: `{ "sessionId": "my_user_1", "status": "connected" }` (Statuses: starting, connecting, qr_required, connected, disconnected)

### `GET /sessions`
List all active sessions currently managed in memory.
- **Returns**: `{ "sessions": [ { "id": "my_user_1", "status": "connected" } ] }`

### `POST /session/:id/reconnect`
Forces a manual socket disconnect and reconnect.
- **Returns**: `{ "success": true, "message": "Reconnecting session my_user_1" }`

### `DELETE /session/:id`
Deletes a session completely, removing all its auth data from Redis and destroying the active socket.
- **Returns**: `{ "success": true, "message": "Session my_user_1 deleted" }`

### `GET /health`
Basic healthcheck endpoint.
- **Returns**: `{ "status": "OK", "timestamp": 1690000000000 }`

---

## Deployment Guides

### Deploying to Koyeb
1. Push this repository to GitHub.
2. In the Koyeb dashboard, create a new Web Service.
3. Select your GitHub repository.
4. Set the builder to **Dockerfile** (Koyeb will automatically detect the provided Dockerfile).
5. In the **Environment Variables** section, add:
   - `PORT`: `3000`
   - `REDIS_URL`: `rediss://default:your_password@your-upstash-endpoint.upstash.io:6379`
   - `API_KEY`: `your_secure_random_string`
6. Deploy the service. Koyeb will expose the API on port 3000 securely.

### Upstash Redis Setup
1. Create a free account at [Upstash](https://upstash.com/).
2. Create a new Redis Database (Global or Regional). Ensure TLS/SSL is enabled.
3. Scroll down to the **Node.js (ioredis)** connection snippet to find your connection string.
4. It should look like: `rediss://default:password@endpoint:port`. Paste this exactly into your `REDIS_URL` environment variable.
