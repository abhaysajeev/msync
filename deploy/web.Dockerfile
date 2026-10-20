# Build the SPA, then serve it (and the media) from Caddy.
FROM node:20-alpine AS build
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM caddy:2.11.7
COPY --from=build /web/dist /srv/web
