# Thidal: API and web app in one container. The SQLite database and uploaded photos live on /data.
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production PORT=3200 TURF_DATA_DIR=/data NODE_NO_WARNINGS=1
COPY package.json ./
COPY server ./server
COPY web ./web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN rm -rf server/tests && chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
EXPOSE 3200
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# NODE_ENV=production makes the server refuse missing or short TURF_SECRET / TURF_WEBHOOK_SECRET.
ENTRYPOINT ["docker-entrypoint.sh"]
