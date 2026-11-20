# Lee Link — single-container deploy (server + built web app + SQLite on a volume).
# The emulator cores are prebuilt WebAssembly in apps/web/public/cores, so no Emscripten here.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build -w apps/web

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data STATIC_DIR=/app/apps/web/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "apps/server/src/index.ts"]
