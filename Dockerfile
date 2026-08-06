# Reference container image for the stdio MCP server (local testing, mcp.so, self-hosting).
#
# NOTE: Glama does NOT build this file. It generates its own Dockerfile from the build spec in
# its admin UI; the values that make that build pass are documented in REGISTRIES.md §1.
# The critical one: the start command must be `dist/mcp.js` (the MCP server). `dist/cli.js` is
# the CLI — it prints usage and exits, so a container pointed at it dies instantly.
#
# Scope: this image runs ONLY the stdio MCP entrypoint. Introspection (`tools/list`) works with
# no configuration at all. Actually invoking a bridge_* tool additionally needs the local daemon
# and a configured chat adapter (see README); that is inherent to a locally-installed tool.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY hooks ./hooks
COPY rules ./rules
COPY config.example.json ./
CMD ["node", "dist/mcp.js"]
