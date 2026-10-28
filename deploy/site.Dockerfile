# Static site: builds HTML from the committed reports, then serves it with a zero-dependency Node server.
FROM node:26.10-slim
WORKDIR /app
COPY . /app
# Optional analytics, set as Railway variables on the site service.
ARG UMAMI_SRC
ARG UMAMI_WEBSITE_ID
RUN UMAMI_SRC="$UMAMI_SRC" UMAMI_WEBSITE_ID="$UMAMI_WEBSITE_ID" node src/site.ts --out /app/site-dist
ENV SITE_DIR=/app/site-dist
CMD ["node", "src/serve.ts"]
