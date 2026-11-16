# Always-on worker image. Build from the project root: docker build -f agent/Dockerfile -t nft-agent .
# Not built or run inside Arc Studio: treat as a starting point and test it on your host.
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY agent ./agent
COPY src/onchain-facts.ts src/onchain-money.ts src/onchain-wait.ts ./src/
# Optional: copy a built dashboard (bun run build) to serve it from the same port.
# COPY dist ./dist
ENV AGENT_DB_PATH=/data/agent.sqlite AGENT_PORT=8787
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "agent/src/main.ts"]
