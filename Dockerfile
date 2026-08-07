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

# The server refuses to boot with DEV_AUTH=true while NODE_ENV=production.
CMD ["node", "src/main.ts"]
