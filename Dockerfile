FROM node:20-alpine

WORKDIR /app

# system deps (for some libs & better TLS)
RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure folders exist
RUN mkdir -p /app/uploads /app/auth

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
