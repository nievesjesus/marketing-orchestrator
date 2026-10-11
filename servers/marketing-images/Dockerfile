# syntax=docker/dockerfile:1
# Build context = servers/marketing-images (Coolify: base directory `servers/marketing-images`).

# ---- build: install all deps, compile TypeScript, keep production deps only ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app

# The base image already ships an unprivileged `node` user (uid 1000); files are owned by it at COPY time
# (a later `chown -R` would duplicate every layer).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Fonts are baked into the image (OFL TTFs + their licenses); nothing is downloaded at runtime.
COPY --chown=node:node fonts ./fonts

# /data is the named volume (SQLite ledger + stored images); owning it here lets a fresh volume
# inherit the right permissions.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node:sqlite still prints an ExperimentalWarning; silence just that one.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
