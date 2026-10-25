FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8787 \
    DB_PATH=/app/data/app.db

COPY package.json ./
COPY app ./app

RUN mkdir -p /app/data

EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/server.js"]
