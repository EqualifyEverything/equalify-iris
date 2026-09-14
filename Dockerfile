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
# `npm ci`, not `npm install`: it installs the lockfile's exact tree and fails rather than
# resolving a newer one, which is most of what a version number on this image is for. That
# makes the lockfile required, so it is copied by name — a missing one is then a COPY error
# naming the file, instead of an `npm ci` error several layers later.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Provide a default config that reads everything from the environment. Mount
# your own config.yaml over this to customize providers/storage.
RUN cp -n config.example.yaml config.yaml || true

EXPOSE 8080

# The container healthcheck src/index.ts's /v1/health comment is written for. That comment
# explains that the route is registered above the rate limiter partly because "a container
# healthcheck runs on the same host" — and until this line, the whole repo's only mention of
# such a healthcheck was that sentence. It is declared here rather than in
# docker-compose.yml because `docker compose` inherits the image's, so this covers both, and
# a second copy in the compose file is the copy that would drift.
#
# `node`, not `curl`: the image installs git and poppler-utils and no HTTP client, and
# adding one to ask a question node answers with a built-in is another package to keep
# patched. `process.exit` on both settlements — a fetch that resolves non-2xx is as unhealthy
# as one that rejects, and an unconsumed body must not hold the process open past its answer.
#
# The start period covers boot: a config load, the mkdir sweep, and the stale-session pass
# all run before listen(). 8080 is EXPOSE's port and config.example.yaml's `server.port`; an
# operator who mounts a config.yaml on a different port has to change both, and this is the
# second one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/index.ts"]
