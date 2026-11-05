FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev postgresql-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

USER node
RUN corepack prepare pnpm@12.16.1 --activate
