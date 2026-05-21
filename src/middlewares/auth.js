import config from '../config/index.js';

export const apiKeyMiddleware = (req, res, next) => {
  if (!config.API_KEY) {
    return next();
  }

  const apiKey = req.headers['x-api-key'] || req.query.apiKey;

  if (apiKey !== config.API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  next();
};

export const errorHandler = (err, req, res, next) => {
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
};
