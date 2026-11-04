FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev postgresql-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

USER vscode
RUN corepack prepare pnpm@9.15.5 --activate
