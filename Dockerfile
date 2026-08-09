# Node >=22.18 runs TypeScript directly via type stripping, so there is no
# build step and no dist/. Keep the version at or above that.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY db ./db
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Drop root. The process serves untrusted input on a public port and needs to
# write nothing; there is no reason for it to be able to.
USER node

# /healthz is the liveness probe: no database call, so a Postgres blip does not
# get every container restarted at once. /readyz is the one that checks the DB.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node, not npm: npm swallows SIGTERM, so the graceful shutdown in
# src/http/server.ts would never run and in-flight bookings would be cut off.
CMD ["node", "src/main.ts"]
