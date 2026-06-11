FROM node:20-alpine

WORKDIR /app

# Copy package manifest + tgz archives
COPY package.json package-lock.json ./
COPY theaiinc-yggdrasil-0.2.3.tgz theaiinc-yggdrasil-ratatoskr-0.2.3.tgz ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Ratatoskr runner daemon — registers with Yggdrasil, polls for tasks,
# executes them in-process using its LLM/agent capability.
CMD ["npx", "tsx", "src/registry.ts"]
