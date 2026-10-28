# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f apps/web/Dockerfile .

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/rbac/package.json packages/rbac/
RUN npm ci --workspace @lms/web --workspace @lms/rbac --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/rbac ./packages/rbac
COPY apps/web ./apps/web
# API_URL is read by next.config rewrites at build time.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @lms/web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S lms && adduser -S lms -G lms
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER lms
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
