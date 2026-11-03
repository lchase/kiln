# Default agent-sandbox image (ticket 07/08, .scratch/yak-engine-roadmap/
# map.md) — `AgentStep.sandbox: 'docker'`'s yak-shipped default, overridable
# via `AgentStep.image`. Not published — built locally:
#   docker build -t yak-agent-sandbox:latest docker/agent-sandbox
#
# Ticket 07's decision: yak ships this default because, unlike a `command`
# step's arbitrary user toolchain (ticket 04's "no default" call), an agent
# step's image has one hard requirement yak itself controls — the
# `claude-code` CLI binary the Agent SDK's `query()` spawns, version-matched
# to this repo's `@anthropic-ai/claude-agent-sdk` dependency.
#
# The npm package for the CLI ships as a platform-specific native binary
# (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, a single `claude`
# executable at the package root — confirmed via `npm pack` against the
# published tarball, no `bin` field). `npm install` resolves the right
# platform variant automatically for whatever architecture this image is
# built on, so the container-side path varies by build arch — the `ln -s`
# below pins that down to one fixed path (`/app/claude-cli`) regardless,
# which src/adapters/claude-code.ts's `spawnClaudeCodeProcess` override
# invokes directly instead of the SDK's own (host-specific, meaningless
# inside a container) resolved executable path.
FROM node:22-slim

WORKDIR /app
RUN npm init -y >/dev/null 2>&1 \
  && npm install --omit=dev @anthropic-ai/claude-agent-sdk@^0.3.228 \
  && ln -s "$(find /app/node_modules/@anthropic-ai -maxdepth 1 -name 'claude-agent-sdk-linux-*' -type d)/claude" \
       /app/claude-cli

WORKDIR /workspace
