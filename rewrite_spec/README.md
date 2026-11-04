# POS rewrite specification

This folder captures the behavior of the existing `_Sell` Windows/WPF point-of-sale app and a small, web-oriented implementation brief for a Rust + React + PostgreSQL rewrite. It is written for an implementing agent; it is not a design mandate to reproduce the old code or screen layout.

## Documents

- [REQUIREMENTS.md](REQUIREMENTS.md) — workflows, observed rules/quirks, and acceptance criteria.
- [UI.md](UI.md) — existing interaction model and proposed browser interactions.
- [DATA.md](DATA.md) — conceptual entities, persistence boundaries, and legacy data.
- [CATALOG.toml](CATALOG.toml) — complete snapshot of the active legacy product catalog for initial seeding.
- [DECISION_LOG.md](DECISION_LOG.md) — resolved product decisions and confirmed exclusions.
- [FEEDBACK.md](FEEDBACK.md) — review notes whose decisions have been consolidated into this specification; use the documents above as the implementation source of truth.

## Purpose and scope

The confirmed application is a small till for selecting configured items, totaling an in-progress sale, tracking a cash-drawer balance, and saving a plain-text receipt. The rewrite is for nonprofit use: no VAT/tax or formal invoicing rules are required. There is no customer/account workflow, inventory, card processing, or POS hardware integration in the inspected code.

The rewrite should preserve quick sale entry while adapting it for browser use. Use a Rust backend, React frontend, and PostgreSQL. Products are managed in PostgreSQL through a settings screen and seeded once through a tracked migration from [`CATALOG.toml`](CATALOG.toml). Informational invoices are durably stored in PostgreSQL; offline submissions are queued in the browser and retried idempotently. The active cart is also browser-persisted and restored on the next successful app load. Cash balance and audit ledger are local browser data with signed adjustments and exact reversals. Authentik OIDC uses frontend authorization code with PKCE and stateless bearer-token API validation; the valid upload token's email claim attributes the server invoice even when `email_verified` is false. There are no in-app roles or live synchronization, and only one user is expected at a time. Offline checkout continues in the already-loaded page after token expiry; queued invoices upload with a fresh valid token. Offline app loading/PWA precaching is not required.

## Evidence labels

- **Confirmed (legacy):** behavior directly visible in the checked-in source.
- **Proposed (web):** implementation-oriented adaptation, not a claim about the old app.
- **Needs decision:** an ambiguity, implementation choice, or apparent legacy defect that should not be guessed silently.

This folder is intended to be usable on its own by the implementing agent. Code paths mentioned in the documents are provenance references for this analysis; they are not required to implement the rewrite. The seed data is fully captured in `CATALOG.toml`, which contains all 13 active products, stable legacy IDs, order, display labels, and prices in cents. The old screenshot is outdated; use the TOML snapshot rather than the screenshot as the starting catalog. A tracked migration must seed it once without overwriting future product edits.

## Specification precedence and handoff

The decisions consolidated in these specifications are the latest product decisions and override both legacy observations and any earlier answers that conflict. Acceptance criteria and validation rules define required observable behavior. UI/model recommendations allow ordinary implementation latitude unless marked as decisions. `DECISION_LOG.md` records the resolved decisions and exclusions.

The implementation handoff should include runnable setup/development instructions, migrations and seed instructions, runtime OIDC configuration documentation, and automated checks for cart recovery/reversal, idempotent retry, and donation/change/validation behavior. Library choices, API route names, and component organization are delegated engineering choices.
