export const authMiddleware = (req, res, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next(); // Skip if no API key configured

  const providedKey = req.headers['x-api-key'] || req.query.api_key;

  if (providedKey !== apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};
