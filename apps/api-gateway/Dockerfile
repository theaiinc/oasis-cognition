FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY .npmrc ./
COPY theaiinc-yggdrasil-0.3.8.tgz theaiinc-yggdrasil-ratatoskr-0.3.8.tgz theaiinc-yggdrasil-runtime-0.3.8.tgz ./
RUN npm install

COPY tsconfig.json nest-cli.json ./
COPY src/ ./src/

RUN npm run build

EXPOSE 8000

CMD ["node", "dist/main.js"]
