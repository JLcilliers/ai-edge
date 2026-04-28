# Reference Dockerfile for the Playwright AIO worker (Phase B #7 / ADR-0010).
#
# Built on Microsoft's Playwright image so Chromium + system fonts +
# all the X / shared-lib dependencies are pre-installed. This is heavy
# (~1.3GB) but it's the only image that reliably runs Playwright
# headless on a stock Linux container without manual lib chasing.
#
# Build:   docker build -t playwright-aio-worker .
# Run:     docker run -e WORKER_SHARED_SECRET=changeme -p 8080:8080 playwright-aio-worker

FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 8080

# Default to headless for production; override via -e HEADLESS=false locally.
ENV HEADLESS=true
ENV PORT=8080

CMD ["node", "server.js"]
