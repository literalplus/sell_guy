# Configuration and operations

## Runtime environment

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | Connection string for the app's dedicated PostgreSQL database/user on the shared PostgreSQL instance. |
| `OIDC_ISSUER` | Yes | Authentik issuer URL; the API discovers OpenID configuration and signing keys from it. |
| `OIDC_CLIENT_ID` | Yes | Public OIDC client used by the browser application. Configure authorization-code + PKCE and the redirect URI. |
| `OIDC_AUDIENCE` | No | Expected access-token audience; defaults to `OIDC_CLIENT_ID` and is also sent as the `audience` authorization parameter. Set a different value only when the provider issues that value in the token's `aud` claim. |
| `OIDC_SCOPE` | No | Defaults to `openid profile email offline_access`; the frontend requests `offline_access` for refresh-token support. |
| `OIDC_REDIRECT_URI` | No | Browser OIDC callback; defaults to `APP_BASE_URL`. |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | No | Browser logout return URL; defaults to `APP_BASE_URL`. |
| `APP_BASE_URL` | No | Public application URL, defaults to `http://localhost:4200`. |
| `API_HOST` / `API_PORT` | No | Listener address; defaults to `0.0.0.0:8080`. |
| `STATIC_DIR` | No | Compiled Vite assets directory; defaults to `/app/static`. |

The app has no in-app roles. Any valid bearer-token identity can manage the
catalog. Invoice upload requires a non-empty `email` claim on the valid access
token (whether or not `email_verified` is true). The API never trusts a
client-provided uploader identity.

For local development, set the values in `.env` (see `.env.example`). In
Authentik, register the frontend redirect and post-logout URLs and enable PKCE.
The frontend uses a public client; do not put a client secret in the browser or
in the Helm chart.

Configure the OIDC provider to allow `offline_access` and issue refresh tokens.
The frontend reuses the access token until its expiry, then uses the refresh
token grant; it does not perform proactive or iframe-based silent renewals.

## PostgreSQL and migrations

Create a dedicated database and role on the shared PostgreSQL service and grant
that role ownership/DDL rights on that database. The service applies SQLx
migrations at startup. To apply them manually during development:

```sh
pnpm db:migrate
```

The initial tracked migration creates product and invoice tables and inserts
the 13 products from `rewrite_spec/CATALOG.toml`. Migration history makes the
seed one-time: subsequent starts do not reset product edits or re-enable
disabled products. New product IDs are generated above legacy ID 23. No legacy
cash files or invoices are imported.

The invoice table has a server-generated `invoice_id` and unique client
`cart_uuid`. An identical payload retried with a cart UUID returns the existing
invoice ID. A different payload for that UUID gets HTTP 409. Invoice JSON
contains the original save time and server receipt time separately.

## Browser persistence and offline behavior

IndexedDB stores one transactional state record containing the active cart,
drawer balance, append-only ledger, operator email, and queued invoice
snapshots. An invoice is moved into the immutable pending queue and the active
cart receives a fresh UUID in one transaction before any network upload. Failed
uploads remain queued; a payload conflict is retained as blocked. The loaded
page remains usable offline; initial app load still needs the static app and
catalog API to be reachable.

The cash ledger is local to that browser profile and is not tamper-evident or
shared between browsers. Every line removal/discard writes exact signed
compensating entries, including when manual adjustments have happened in
between.

## Podman image and Helm

Build and run the production image:

```sh
podman build -t sell-guy:latest .
podman run --rm -p 8080:8080 --env-file .env \
  -e APP_BASE_URL=http://localhost:8080 \
  -e OIDC_REDIRECT_URI=http://localhost:8080/ \
  -e OIDC_POST_LOGOUT_REDIRECT_URI=http://localhost:8080/ \
  sell-guy:latest
```

The Alpine OCI image contains the Rust API and built React static files; the API
serves both from one origin. The Helm chart is under `deploy/helm/sell-guy` and
does not deploy PostgreSQL. Create a Kubernetes Secret containing `DATABASE_URL`
for the dedicated application database/user, then set `database.existingSecret`
and override the OIDC values, ingress hostname/class/TLS, image repository/tag,
redirect URLs, and `app.baseUrl` in the values applied by ArgoCD. Keep credentials
in a secret manager/Secret rather than plain values. Database migrations run
when the application starts.

The development container is configured through `.devcontainer/devcontainer.json`
and `.devcontainer/compose.yaml`; it includes PostgreSQL 16 and uses a separate
development-only database role. In a Podman environment, the Dev Containers
client must use Podman as its Docker-compatible CLI and a Compose provider such
as `podman compose`/`podman-compose`. See the repository README for setup steps.

For a non-container local toolchain, use `nix-shell` from the repository root;
the `shell.nix` environment includes Node/Corepack, Rust, PostgreSQL, Podman, and
Kubernetes Helm. Further implementation assumptions and known follow-up work are
recorded in [`CAVEATS.md`](../CAVEATS.md).
