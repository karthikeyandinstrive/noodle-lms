# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f apps/api/Dockerfile .

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/rbac/package.json packages/rbac/
RUN npm ci --workspace @lms/api --workspace @lms/db --workspace @lms/rbac --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run build -w @lms/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S lms && adduser -S lms -G lms
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
# Migrations + scripts run with tsx from source.
COPY --from=build /app/packages ./packages
COPY package.json tsconfig.base.json ./
USER lms
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "apps/api/dist/server.js"]
