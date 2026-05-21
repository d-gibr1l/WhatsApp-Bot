FROM node:20-alpine

WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (production only to avoid lockfile issues and keep image small)
RUN npm install --omit=dev

# Copy source code
COPY . .

# Expose API port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
