FROM node:20-alpine

WORKDIR /app

# Install runtime deps + source (single stage — app is small)
COPY package.json tsconfig.json ./
COPY theaiinc-yggdrasil-0.3.8.tgz theaiinc-yggdrasil-ratatoskr-0.3.8.tgz theaiinc-yggdrasil-runtime-0.3.8.tgz ./
RUN npm install --no-package-lock && npm cache clean --force

COPY src/ ./src/

EXPOSE 3100

ENV PORT=3100
ENV NODE_ENV=production

# Combined orchestration controller + built-in Ratatoskr runner.
# Yggdrasil IS the agent pool — no separate runner needed.
CMD ["npx", "tsx", "src/yggdrasil-pool.ts"]
