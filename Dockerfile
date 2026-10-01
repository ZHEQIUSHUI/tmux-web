# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY build.mjs tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
# Only the web service and an SSH client: tmux and the agents run on the hosts it SSHes into.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/server.js"]
