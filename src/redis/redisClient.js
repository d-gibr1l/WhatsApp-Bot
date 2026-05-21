import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

export const redisClient = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 5,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redisClient.on("error", (err) => {
  console.error("Redis connection error:", err);
});

redisClient.on("connect", () => {
  console.log("Redis connected successfully.");
});
