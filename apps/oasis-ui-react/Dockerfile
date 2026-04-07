FROM node:20-alpine AS builder

# Mirror the monorepo structure so tsconfig paths resolve correctly
WORKDIR /repo/apps/oasis-ui-react

# Install dependencies first (cache layer)
COPY apps/oasis-ui-react/package*.json ./
COPY apps/oasis-ui-react/.npmrc ./
RUN npm install

# Copy shared UI kit to matching path (../../packages/ui-kit from workdir)
COPY packages/ui-kit/ /repo/packages/ui-kit/

# Copy app source
COPY apps/oasis-ui-react/ .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /repo/apps/oasis-ui-react/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
