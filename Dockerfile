# Uses the Docker Engine's bundled frontend; no separate Docker Hub frontend pull.
FROM debian:bookworm-slim AS whisper-build
ARG WHISPER_VERSION=v1.9.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git cmake build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp.git /build/whisper
RUN cmake -S /build/whisper -B /build/whisper/build \
      -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DGGML_OPENMP=ON -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_SERVER=OFF -DWHISPER_CURL=OFF \
    && cmake --build /build/whisper/build --target whisper-cli --parallel 2

FROM node:24-bookworm AS app-build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Install Linux native modules here; never copy a Windows node_modules folder.
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=4317 \
    WHISPER_BINARY=/opt/whisper/bin/whisper-cli \
    WHISPER_THREADS=2
COPY --from=whisper-build /build/whisper/build/bin/whisper-cli /opt/whisper/bin/whisper-cli
COPY --from=app-build /app/package.json /app/package-lock.json /app/tsconfig.json ./
# tsx is intentionally retained: the server runs TypeScript under Node 24.
COPY --from=app-build /app/node_modules ./node_modules
COPY --from=app-build /app/src ./src
COPY --from=app-build /app/dist ./dist
COPY scripts/setup-speech-linux.mjs ./scripts/setup-speech-linux.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "--use-env-proxy", "--import", "tsx", "src/server/index.ts"]
