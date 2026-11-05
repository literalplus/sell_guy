# sell_guy

A small, offline-tolerant point-of-sale application. The Nx workspace contains a
React frontend and Rust API; the API serves the compiled frontend in production.

## Requirements

- Node.js 20+ and pnpm 9+
- Rust stable (the backend uses SQLx)
- PostgreSQL 15+; use a dedicated database and user on your shared instance
- Podman for local OCI images/containers (Docker-compatible commands are not assumed)

## Development

### Devcontainer (PostgreSQL included)

1. Copy `.env.example` to `.env` and enter the Authentik issuer, client ID, and
   audience. The devcontainer starts a PostgreSQL 18 container with a local-only
   development role/database and applies migrations after creating the workspace.
2. Open the repository in VS Code and choose **Reopen in Container**. The
   workspace exposes the Vite app at `http://localhost:4200` and API at
   `http://localhost:8080`; the PostgreSQL container is also published at
   `localhost:5433` for host-side tools.

The devcontainer uses the Podman-compatible Compose setup in
`.devcontainer/compose.yaml`; workspace settings select `podman` and
`podman-compose` for the Dev Containers extension. On a systemd user session,
the Podman API socket can be started with
`systemctl --user enable --now podman.socket`. Make sure the Authentik issuer in
`.env` is reachable from inside the workspace container. Launch VS Code from
`nix-shell` so the extension can find `podman-compose`, or install that provider
on the host.

### Local shell

Enter the toolchain with `nix-shell`. It provides Node/Corepack, Rust, PostgreSQL
tools, Podman/Podman Compose, and Kubernetes Helm. For a local development
database (skip this when using the shared instance), start PostgreSQL with:

```sh
podman run --name sell-guy-postgres \
  -e POSTGRES_DB=sell_guy -e POSTGRES_USER=sell_guy -e POSTGRES_PASSWORD=change-me \
  -p 5432:5432 -d docker.io/library/postgres:16-alpine
```

Then run:

```sh
corepack pnpm@9.15.5 install
corepack pnpm@9.15.5 db:migrate
corepack pnpm@9.15.5 dev
```

### Manual setup

1. Create a database and user, then set `DATABASE_URL` to that database's
   connection string. For example:

   ```sh
   export DATABASE_URL='postgres://sell_guy:change-me@localhost:5432/sell_guy'
   ```

2. Copy `.env.example` to `.env` and fill in the Authentik OIDC issuer, client
   ID, audience, and local redirect URLs. The frontend uses authorization code
   with PKCE; the API discovers the issuer's JWKS and validates bearer tokens.

3. Install dependencies and run migrations plus the app:

   ```sh
   pnpm install
   pnpm db:migrate
   pnpm dev
   ```

   The frontend is available at <http://localhost:4200>; Vite proxies `/api` to
   the Rust service on port 8080. `pnpm dev` runs the migration before starting
   the API and frontend. `pnpm db:migrate` can also be run independently.

## Checks

```sh
pnpm test
pnpm lint
cargo test --manifest-path apps/api/Cargo.toml
```

## Deployment

Build the Alpine image with `podman build -t sell-guy:latest .`. The Helm chart
under `deploy/helm/sell-guy` deploys only the application and connects to an
existing PostgreSQL database. Supply its dedicated database URL (preferably
through a Kubernetes Secret), OIDC settings, image, ingress, and public URLs in
the chart values managed by ArgoCD. Database migrations run at application
startup; SQLx tracks applied migrations and the catalog seed does not overwrite
operator edits.

See [docs/configuration.md](docs/configuration.md) for runtime configuration,
migration, and deployment details. See [CAVEATS.md](CAVEATS.md) for current
assumptions, limitations, and follow-up work. The full product behavior and
acceptance criteria are in [`rewrite_spec/`](rewrite_spec/README.md).
