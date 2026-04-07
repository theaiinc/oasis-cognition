FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY .npmrc ./
RUN npm install

COPY tsconfig.json nest-cli.json ./
COPY src/ ./src/

RUN npm run build

EXPOSE 8000

CMD ["node", "dist/main.js"]
