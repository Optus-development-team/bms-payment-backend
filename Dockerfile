# Builder stage compiles TypeScript and installs dependencies without dev packages.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
RUN npm run download-chromium
COPY . .
RUN npm run build

# Runner stage copies only what is needed to run the app in production.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
