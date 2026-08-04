FROM node:20-alpine AS builder
WORKDIR /build

# Move into oasis-agent subdir
RUN mkdir -p oasis-agent agent-runner

# Copy oasis-agent package files
COPY apps/oasis-agent/package.json apps/oasis-agent/tsconfig.json ./oasis-agent/

# Copy vendored packages (package.json references these via file:../agent-runner/...)
COPY apps/agent-runner/theaiinc-yggdrasil-0.3.8.tgz apps/agent-runner/theaiinc-yggdrasil-ratatoskr-0.3.8.tgz apps/agent-runner/theaiinc-yggdrasil-runtime-0.3.8.tgz ./agent-runner/

WORKDIR /build/oasis-agent
RUN npm install

# Copy source
COPY apps/oasis-agent/src ./src
RUN npx tsc

FROM node:20-alpine AS runtime
WORKDIR /app

# Copy built artifacts and node_modules (no need for tgz at runtime)
COPY --from=builder /build/oasis-agent/node_modules ./node_modules
COPY --from=builder /build/oasis-agent/dist ./dist

EXPOSE 8020
CMD ["node", "dist/index.js"]
