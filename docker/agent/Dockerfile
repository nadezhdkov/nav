# The image of hardened agent containers (L3, ADR 0069): Node (the entry script that bridges the egress proxy
# needs it), git and ripgrep (agents expect them) and the agent CLIs Navarch can run hardened.
# Build with `make agent-image`; pin versions with --build-arg for a reproducible image.
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force
# The container runs as the operator's uid with a home Navarch mounts, so nothing else is set up here.
