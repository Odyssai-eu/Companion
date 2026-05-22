FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# rsync + ssh for the orchestrator features that sync files / set up SSH
# keys on user-managed cluster nodes (POST /api/admin/nodes/:id/ssh-setup
# uses sshpass during the one-shot key bootstrap; after that all auth is
# via the orchestrator's ed25519 key, persisted under /home/node/.companion/).
RUN apk add --no-cache rsync openssh-client sshpass

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle
# User-guide markdown corpus for /help BM25 search. Same files the
# dev-time loader reads from src/content/user-guide/; in production
# the runtime image gets them copied flat to /app/wiki so the server
# can readdirSync them at boot.
COPY src/content/user-guide ./wiki

EXPOSE 3000
ENV PORT=3000
CMD ["npm", "start"]
