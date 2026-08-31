# The MCP server only. There is deliberately no browser, no Python and no
# scraping toolchain in here: this process talks HTTP to SearXNG and Crawl4AI
# and owns none of their work. If this image ever needs a browser, something
# has been reimplemented that should have stayed upstream.
#
# NODE_IMAGE comes from versions.env so the base is pinned in the same single
# place as the upstream images.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app

RUN corepack enable

# Install from the lockfile first so dependency layers survive source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Drop everything the runtime does not need: typescript, eslint, tsx.
RUN pnpm prune --prod

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Run unprivileged. The base image ships a `node` user; using it means a flaw
# in a dependency does not start out as root.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Probes the unauthenticated information route: it proves the process is
# serving without needing a credential inside the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
