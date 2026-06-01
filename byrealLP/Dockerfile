# Byreal LP server — Node + byreal-cli, for Railway
FROM node:20-slim

WORKDIR /app

# Install the Byreal CLI globally (server shells out to `byreal-cli`)
RUN npm install -g @byreal-io/byreal-cli@0.3.6

# Install server dependencies (cached unless package.json changes)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source
COPY server.js ./

# Railway provides $PORT; server reads process.env.PORT
EXPOSE 3000
CMD ["node", "server.js"]
