FROM node:24-bookworm-slim AS web
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build:online

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3117 YIJIAN_DATA_DIR=/data
WORKDIR /app/online
COPY online/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY online/src/ ./src/
COPY online/migrations/ ./migrations/
COPY --from=web /build/web/dist-online/ /app/web/dist-online/
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3117
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3117/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
