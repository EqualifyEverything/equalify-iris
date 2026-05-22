# Multi-arch image (linux/amd64, linux/arm64). Mac Mini and Linux ARM
# workstations are first-class targets (PRD §10.4).
FROM node:24-slim

# git is required: agents/ is a git checkout (SHA pinning, PRD §7.3) and the
# contribution workflow inspects it.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install runtime dependencies only. The service runs TypeScript directly via
# Node's built-in type stripping, so there is no build step.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Provide a default config that reads everything from the environment. Mount
# your own config.yaml over this to customize providers/storage.
RUN cp -n config.example.yaml config.yaml || true

EXPOSE 8080
CMD ["node", "--experimental-sqlite", "src/index.ts"]
