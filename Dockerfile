FROM docker.io/library/node:22-alpine AS frontend-build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml nx.json tsconfig.base.json ./
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm exec nx build web

FROM docker.io/library/rust:alpine AS backend-build
WORKDIR /workspace
RUN apk add --no-cache build-base perl musl-dev
COPY apps/api/Cargo.toml ./apps/api/Cargo.toml
COPY apps/api/Cargo.lock ./apps/api/Cargo.lock
COPY apps/api/src ./apps/api/src
COPY apps/api/migrations ./apps/api/migrations
RUN cargo build --release --locked --manifest-path apps/api/Cargo.toml

FROM docker.io/library/alpine:3.21 AS runtime
RUN apk add --no-cache ca-certificates libgcc && addgroup -S app && adduser -S -G app app
WORKDIR /app
COPY --from=backend-build /workspace/apps/api/target/release/sell-guy-api /usr/local/bin/sell-guy-api
COPY --from=frontend-build /workspace/apps/web/dist /app/static
ENV API_HOST=0.0.0.0 API_PORT=8080 STATIC_DIR=/app/static
EXPOSE 8080
USER app
ENTRYPOINT ["/usr/local/bin/sell-guy-api", "serve"]
