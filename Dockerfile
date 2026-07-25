# One-command containerized deploy (SPEC §13.7). Symphony is a no-build TypeScript
# app run directly under Node's type-stripping mode, so the image is just Node +
# the source tree + production deps. The container serves the file-tracker
# console on :8420; agent CLIs (codex/opencode) are NOT bundled — see README.
FROM node:24-slim

# Non-root user for the orchestrator and HTTP server.
RUN groupadd --system symphony && useradd --system --gid symphony --create-home --home-dir /app symphony

WORKDIR /app

# Install git (for repository delivery: worktrees, push-branch) alongside
# production deps. node:24-slim ships without it. One layer to keep the image
# small; apt lists are cleaned so they don't leak into the layer.
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* && npm ci --omit=dev

# Then copy the rest of the source (node_modules is excluded by .dockerignore).
COPY . .

# Where issue workspaces and per-project state live; owned by the runtime user
# so the bind/named volume mounts are writable. The named volume at /app/.symphony
# is seeded from this mountpoint's ownership, so it must exist and be owned by
# the runtime uid (999) before the volume is attached.
RUN mkdir -p /app/issues /app/.symphony && chown -R symphony:symphony /app

USER symphony

EXPOSE 8420

# Bind loopback by default. The image sets no SYMPHONY_HOST; operators opt in to
# exposing the unauthenticated console (e.g. SYMPHONY_HOST=0.0.0.0 via compose
# or --host) when they publish the port (SPEC §13.7).
ENTRYPOINT ["node", "src/index.ts", "./WORKFLOW.md", "--port", "8420"]
