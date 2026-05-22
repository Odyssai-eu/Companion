FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Admin Extended: the orchestrator runs rsync over ssh from this container
# to user-managed nodes. sshpass is used during the one-shot key-bootstrap
# step (POST /api/admin/nodes/:id/ssh-setup); after that all auth is by
# the orchestrator's ed25519 key, persisted under /home/node/.thecompai/.
RUN apk add --no-cache rsync openssh-client sshpass

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle
# User-guide markdown corpus for /help BM25 search. Same files the
# dev-time loader reads from src/content/user-guide/; in production
# the runtime image gets them copied flat to /app/wiki so the server
# can readdirSync them at boot.
COPY src/content/user-guide ./wiki

EXPOSE 3000
ENV PORT=3000
CMD ["pnpm", "start"]
