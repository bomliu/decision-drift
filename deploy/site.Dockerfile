# Static site: builds HTML from the committed reports, then serves it with a zero-dependency Node server.
FROM node:26.10-slim
WORKDIR /app
COPY . /app
RUN node src/site.ts --out /app/site-dist
ENV SITE_DIR=/app/site-dist
CMD ["node", "src/serve.ts"]
