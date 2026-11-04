# Caveats, assumptions, and follow-up work

This file records implementation details that are important when developing,
deploying, or extending the current rewrite. The product decisions in
[`rewrite_spec/`](rewrite_spec/README.md) remain the behavioral source of truth.

## Assumptions made

- PostgreSQL is an existing shared service. Sell Guy uses a dedicated database
  and database role; the role must be able to create and migrate objects in that
  database. The Helm chart does not install or manage PostgreSQL.
- Authentik is an external OIDC provider. Its issuer discovery endpoint must be
  reachable by the Rust API at startup, and the public client must allow
  authorization-code flow with PKCE and the exact deployed redirect URLs.
- The configured audience must appear in the access token's `aud` claim. The
  browser also sends the configured audience as an `audience` authorization
  parameter; confirm that this matches the Authentik application/provider
  configuration in the target environment.
- One operator/browser profile is expected at a time. Product data is global;
  cash balance and its ledger belong to one browser's IndexedDB.
- The production OCI image is built with Podman in this environment. The image
  uses the conventional `Dockerfile` filename but does not require the Docker
  engine.

## Material limitations

- **The external integrations were not tested end-to-end.** The OCI image was
  built with Podman and the migration was smoke-tested against a disposable
  PostgreSQL 16 container (including seed count, next ID, and preservation of a
  later product edit/disablement on migration rerun). It was not tested against
  the target shared PostgreSQL service or an Authentik tenant. Verify real
  credentials/grants, login/token claims, and deployed ingress/redirect values
  in staging.
- **Database-backed behavior has unit-level, not integration-level, coverage.**
  Tests cover invoice validation and identical-versus-conflicting payload
  comparison. PostgreSQL uniqueness and concurrent submissions still lack
  automated integration tests. The one-time seed was manually checked against
  PostgreSQL, but its preservation scenario should be added to an automated
  migration test. The current migration's `ON CONFLICT DO NOTHING` plus SQLx
  migration history is designed to seed only once.
- **The app applies migrations at startup.** The runtime database role needs
  DDL rights. The chart defaults to one replica. Before scaling out, validate
  migration startup behavior with the chosen SQLx version, database proxy, and
  rollout strategy; keep schema changes backward-compatible across rolling
  releases.
- **The browser ledger is best-effort local audit data.** It is not tamper-proof,
  backed up, synchronized, or available from another browser/device. Clearing
  browser storage loses it. Server invoices remain in PostgreSQL, but there is
  intentionally no invoice history/report UI.
- **Offline operation requires the already-loaded page.** Catalog edits require
  a server connection; the catalog is not live-updated after checkout has
  loaded. Offline refresh/PWA caching are intentionally absent.
- **Invoice attribution requires an email claim.** Uploads with a valid token
  but missing/blank `email` are rejected and remain queued. `email_verified` is
  deliberately not required; the upload token's email is the server-side
  attribution.
- **The app has no authorization roles.** Any valid authenticated operator can
  change the shared product catalog. This matches the specification's
  single-user/manual-provisioning assumption, but is not suitable if the app is
  later opened to a broader user population without adding access controls.

## Future cleanups

- Add PostgreSQL integration tests for applying the migration to a fresh
  database, rerunning migrations after catalog edits/disablements, generated ID
  advancement, invoice insert/retry/conflict behavior, and concurrent retries.
- Add a staging smoke-test checklist (or automated deployment test) for
  Authentik issuer/audience, PKCE callback/logout URLs, real JWT key rotation,
  and invoice upload attribution.
- Decide and document production invoice retention, database backup/restore, and
  local drawer-ledger recovery expectations. No retention or export workflow is
  currently implemented.
- Revisit automatic startup migrations if deployments become multi-replica or
  if the application database role should not retain DDL privileges; a separate
  migration job is a possible operational follow-up.
- Add production image scanning/signing and pin image references by digest in
  the ArgoCD-managed values. The chart intentionally leaves repository/tag and
  environment-specific URLs configurable.
- Pin the Nix package set with a flake/lock file if reproducibility across
  developer machines becomes important; the current `shell.nix` uses the
  caller's `<nixpkgs>` channel.

## Not included by design

No inventory, customer accounts, tax/VAT, payment-terminal/card processing,
cash-denomination accounting, receipt printing, PWA precaching, invoice
history/reporting, or cross-browser ledger synchronization is implemented.
