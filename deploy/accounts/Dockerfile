FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src/accounts ./src/accounts
COPY scripts/build-accounts.mjs ./scripts/build-accounts.mjs
RUN node scripts/build-accounts.mjs
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 ALLYCODE_AUTH_DATA=/data
WORKDIR /app
COPY --from=build /build/dist-account/server.mjs ./server.mjs
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
