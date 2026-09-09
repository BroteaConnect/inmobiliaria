# syntax=docker/dockerfile:1
# Three stages, because this app is a node server and not a directory of files:
# the property page is rendered per request (the CRM publishes listings every
# day), while the catalogue and the legal pages stay prerendered and are served
# as static files by the same server.
# The runtime needs production dependencies — but NOT the development ones,
# which are half the weight (typescript, @astrojs/check), so they are installed
# once in their own stage and copied in.
#
# Coolify must use build_pack=dockerfile and route the domain to port 4321.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
# PUBLIC_* vars are inlined into the bundle at build time. The composer
# wires one ARG/ENV pair per feature right below this anchor; the deploy
# skill supplies the values as Coolify build args.
# brotea:build-args
ARG PUBLIC_BUILD_COMMIT
ENV PUBLIC_BUILD_COMMIT=$PUBLIC_BUILD_COMMIT
ARG PUBLIC_PB_URL
ENV PUBLIC_PB_URL=$PUBLIC_PB_URL
ARG PUBLIC_GLITCHTIP_DSN
ENV PUBLIC_GLITCHTIP_DSN=$PUBLIC_GLITCHTIP_DSN
ARG PUBLIC_UMAMI_WEBSITE_ID
ENV PUBLIC_UMAMI_WEBSITE_ID=$PUBLIC_UMAMI_WEBSITE_ID
ARG PUBLIC_UMAMI_SRC
ENV PUBLIC_UMAMI_SRC=$PUBLIC_UMAMI_SRC
RUN npm run build
# Bricks that must PROVE something about the built artifact wire their check
# below this anchor. The form incident of 2026-07-29 is why: a landing shipped
# with no endpoint in its HTML, the build was green, and the form was dead for
# days. A warning would have been ignored; a failing build cannot be.
# Note for SSR: the pages are in dist/server/, not dist/ — a grep aimed at
# static HTML finds nothing here and passes for the wrong reason.
# brotea:post-build
# The lead form posts from the browser, so its endpoint lives in the client
# bundle (dist/client), and the build stamp must be a static file the server
# can hand out: both are checked here, not assumed.
RUN grep -rq 'api.brotea.dev/requirements' dist/client/ && test -f dist/client/version.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The adapter listens on localhost unless told otherwise, and inside a
# container that means NOBODY can reach it from outside. The app then looks
# deployed and answers nothing.
ENV HOST=0.0.0.0
ENV PORT=4321
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
EXPOSE 4321
USER node
CMD ["node", "./dist/server/entry.mjs"]
