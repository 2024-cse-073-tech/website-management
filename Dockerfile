FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    DATABASE_PATH=data/project_assistant_js.db

WORKDIR /app

COPY --chown=node:node package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docs ./docs
COPY --chown=node:node README.md ./

RUN mkdir -p /app/data /app/exports && chown -R node:node /app/data /app/exports

USER node
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
