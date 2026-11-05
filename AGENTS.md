# Repository guidance

- This is an Nx monorepo: React/TypeScript lives in `apps/web`; the Rust API,
  SQLx migrations, and backend tests live in `apps/api`.
- Follow `rewrite_spec/` as the behavior source of truth. Keep money in integer
  cents, preserve IndexedDB transactionality, and keep invoice retries immutable
  and idempotent.
- Enter `nix-shell` before development and verification commands; it provides
  most required tools, including Node/Corepack. Invoke pnpm as
  `corepack pnpm@12.16.1 <command>` inside the shell. pnpm 12 uses a native
  executable; on NixOS without `nix-ld`, run pnpm commands in the devcontainer.
- Run `corepack pnpm@12.16.1 test`, `corepack pnpm@12.16.1 lint`, and
  `corepack pnpm@12.16.1 build` for application changes. Run
  `helm lint deploy/helm/sell-guy` for chart changes.
- PostgreSQL changes belong in tracked SQLx migrations. The app uses an existing
  PostgreSQL database; do not add a production database deployment to Helm.
- Use Podman for local image/container commands. Keep Authentik, database,
  ingress, and public URL configuration runtime-provided; never commit secrets.
- Keep setup and operational caveats current in `README.md`, `docs/`, and
  `CAVEATS.md` when behavior or deployment assumptions change.
