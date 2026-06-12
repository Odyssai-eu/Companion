FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
# Retry once: esbuild's postinstall execs the binary it just wrote, which
# intermittently hits ETXTBSY on Docker Desktop (macOS) — especially when
# compose bake builds images in parallel. The second attempt finds the
# binary settled and validates fine.
RUN npm ci --no-audit --no-fund || (sleep 2 && npm ci --no-audit --no-fund)

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
RUN npm ci --omit=dev --no-audit --no-fund || (sleep 2 && npm ci --omit=dev --no-audit --no-fund)

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
