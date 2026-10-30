# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci \
  && apk del .build-deps

FROM base AS build
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
COPY --from=deps /app/node_modules ./node_modules
RUN npm run build

FROM base AS prod-deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force

FROM base AS runner
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Dashboard is served by express.static("public") relative to the working dir
COPY public ./public
RUN mkdir -p data/portfolio-store backups && chown -R node:node data backups
USER node
EXPOSE 3000
# Startup loads the ~155k-symbol instrument master before listening, hence the long start period
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
