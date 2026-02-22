FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production
FROM base AS production
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./

EXPOSE 3001

CMD ["node", "dist/index.js"]
