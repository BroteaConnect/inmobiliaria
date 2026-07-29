# syntax=docker/dockerfile:1
# Multi-stage: build the static Astro site, serve dist/ with nginx.
# Coolify must use build_pack=dockerfile — nixpacks has no start command
# for static sites and crash-loops (503).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
# PUBLIC_* vars are inlined into the bundle at build time. The composer
# wires one ARG/ENV pair per feature right below this anchor; the deploy
# skill supplies the values as Coolify build args.
# brotea:build-args
ARG PUBLIC_PB_URL
ENV PUBLIC_PB_URL=$PUBLIC_PB_URL
ARG PUBLIC_GLITCHTIP_DSN
ENV PUBLIC_GLITCHTIP_DSN=$PUBLIC_GLITCHTIP_DSN
ARG PUBLIC_UMAMI_WEBSITE_ID
ENV PUBLIC_UMAMI_WEBSITE_ID=$PUBLIC_UMAMI_WEBSITE_ID
ARG PUBLIC_UMAMI_SRC
ENV PUBLIC_UMAMI_SRC=$PUBLIC_UMAMI_SRC
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
