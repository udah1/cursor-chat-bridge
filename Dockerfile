# Container image used by Glama (https://glama.ai/mcp/servers/udah1/cursor-chat-bridge)
# to build the server, run security scans, and let users deploy it.
#
# Scope: this image runs ONLY the stdio MCP entrypoint. Introspection (`tools/list`)
# works with no configuration at all — that is what Glama's build test exercises.
# Actually invoking a bridge_* tool additionally needs the local daemon and a
# configured chat adapter (see README); that is inherent to a locally-installed tool.

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
