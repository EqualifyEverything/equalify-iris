# Multi-arch image (linux/amd64, linux/arm64). Mac Mini and Linux ARM
# workstations are first-class targets (README, "One machine, no vendor lock-in").
FROM node:24-slim

# git: agents/ is a git checkout (SHA pinning) and the contribution
# workflow inspects it. poppler-utils: pdftoppm/pdfinfo for rasterizing uploaded
# PDFs into per-page images, and pdftohtml for reading their link annotations,
# which rasterizing destroys (src/pipeline/links.ts).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install runtime dependencies only. The service runs TypeScript directly via
# Node's built-in type stripping, so there is no build step.
#
# `npm ci` rather than `npm install`: it installs exactly what package-lock.json
# pins and fails if the lockfile disagrees with package.json, so the image a
# version number names is the one this repo describes. The lockfile is required,
# which is the point — `npm install` would quietly resolve new versions without it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Provide a default config that reads everything from the environment. Mount
# your own config.yaml over this to customize providers/storage.
RUN cp -n config.example.yaml config.yaml || true

# Run as the image's unprivileged `node` user (uid/gid 1000) rather than root.
#
# `data/` is created here, owned by that user, because it is where every session and the
# SQLite database are written and the process cannot chown it once privileges are dropped.
# THE CATCH, stated again beside the bind mounts in docker-compose.yml: a bind-mounted host
# directory keeps its HOST ownership, so on Linux `./data` must be writable by uid 1000 —
# and it fails at STARTUP, not on the first upload: src/index.ts creates sessions/ and tmp/
# at import, before the port is bound, so the container exits and never answers /v1/health.
# It prints the chown to run. On macOS and Windows, Docker runs in a VM whose file sharing
# remaps ownership and nothing is needed (checked: compose up on colima/Docker 27.4 writes
# `./data` as the host user while the process runs as uid 1000).
RUN mkdir -p data && chown -R node:node data
USER node

EXPOSE 8080

# Liveness probe for the container runtime, answering the same route a load balancer polls
# (src/index.ts's /v1/health, mounted above the rate limiter so this cannot be throttled
# into reporting a healthy deployment as down).
#
# 8080 is `server.port` from config.example.yaml, which is what config.yaml is copied from
# above. Mount a config with a different port and this line needs the same number.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/index.ts"]
