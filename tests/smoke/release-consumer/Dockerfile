FROM oven/bun:1

ARG PACKAGE_TGZ

WORKDIR /app

COPY tests/smoke/release-consumer/package.json ./package.json
COPY tests/smoke/release-consumer/tsconfig.json ./tsconfig.json
COPY tests/smoke/release-consumer/index.ts ./index.ts
COPY ${PACKAGE_TGZ} /tmp/prokube.tgz

RUN bun install
RUN bun run index.ts
RUN bunx tsc --noEmit
