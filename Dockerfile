# One-command containerized deploy (SPEC §13.7). Symphony is a no-build TypeScript
# app run directly under Node's type-stripping mode, so the image is just Node +
# the source tree + production deps. The container serves the file-tracker
# console on :8420; agent CLIs (codex/opencode) are NOT bundled — see README.
FROM node:24-slim

# Non-root user for the orchestrator and HTTP server.
RUN groupadd --system symphony && useradd --system --gid symphony --create-home --home-dir /app symphony

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Then copy the rest of the source (node_modules is excluded by .dockerignore).
COPY . .

# Where issue workspaces and history.db live; owned by the runtime user so the
# bind/named volume mounts are writable.
RUN mkdir -p /app/issues && chown -R symphony:symphony /app

USER symphony

EXPOSE 8420

# Bind loopback by default; set SYMPHONY_HOST=0.0.0.0 to expose the console.
ENV SYMPHONY_HOST=0.0.0.0
ENTRYPOINT ["node", "src/index.ts", "./WORKFLOW.md", "--port", "8420"]