# Daily collector: runs the probe suite, reports, and commits results to the public and private repos.
FROM node:26.10-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/collect.sh /app/collect.sh
CMD ["sh", "/app/collect.sh"]
