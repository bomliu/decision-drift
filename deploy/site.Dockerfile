# Static site: builds HTML from the committed reports, then serves it with a zero-dependency Node server.
FROM node:26.10-slim
WORKDIR /app
# Share cards: site.ts draws each page's link-preview image as SVG and needs rsvg-convert, plus fonts, to make the PNG.
# Without them the build still works and every page uses the generic card.
RUN apt-get update && apt-get install -y --no-install-recommends librsvg2-bin fonts-liberation && rm -rf /var/lib/apt/lists/*
# The cards' serif: Gelasio Bold has Georgia's letter widths (OFL, see deploy/fonts/Gelasio-OFL.txt).
COPY deploy/fonts/Gelasio-Bold.ttf /usr/local/share/fonts/
COPY . /app
# Optional analytics, set as Railway variables on the site service.
ARG UMAMI_SRC
ARG UMAMI_WEBSITE_ID
RUN UMAMI_SRC="$UMAMI_SRC" UMAMI_WEBSITE_ID="$UMAMI_WEBSITE_ID" node src/site.ts --out /app/site-dist
ENV SITE_DIR=/app/site-dist
CMD ["node", "src/serve.ts"]
