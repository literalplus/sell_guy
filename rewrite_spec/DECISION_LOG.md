# Decision log

## Decisions recorded

1. **Concurrency and catalog:** only one user uses the app concurrently. Products are global PostgreSQL data fetched on page load; there is no live sync. The local drawer remains per browser.
2. **Persisted cart and drawer:** persist the active cart and recover it on the next successful app load. Persist cart, signed drawer balance, ledger, and pending submissions transactionally so effects cannot be duplicated or lost across interrupted writes. A loaded page may be used offline, but loading the app itself while offline is not required.
3. **Signed drawer and reversals:** drawer balance may be negative. Cart additions apply signed changes immediately; removing/reducing lines or discarding an unsaved cart appends the exact inverse delta, including after intervening manual adjustments. `Speichern` and `Verwerfen` must be clearly distinct actions. This supersedes the earlier zero-clamp answer.
4. **Save/idempotency lifecycle:** assign a stable client cart UUID before the first save attempt and persist it. Server assigns a distinct invoice primary key. Save snapshots are immutable; a durable local pending snapshot is created before network submission. Same UUID/same payload returns the existing invoice; same UUID/different payload is rejected without overwrite. Uncertain submissions stay pending and unchanged; a separate new active cart may be used. The initial successful upload sets invoice uploader attribution; an idempotent retry never overwrites it.
5. **Invoice attribution:** server-stored invoice attribution comes from the valid bearer token used to upload, not the original offline operator or a client-supplied email. No cross-user matching restriction is required. Local ledger entries retain the email claim captured at event time.
6. **Donations and change:** donation is informational and excluded from chargeable invoice total, but increases the drawer and cash amount due. `cash amount due = chargeable total + donation total`; `change = amount received - cash amount due`.
7. **Validation:** product/custom/donation amounts are strictly positive; quantities are positive whole numbers; no fractional cents or rounding; empty carts cannot be saved; donation-only carts can be saved with zero chargeable total. Currency entry accepts dot or comma decimal separators and rejects grouping separators and >2 fractional digits.
8. **Invoice data:** JSON snapshot has a schema version, cart UUID, save-event timestamp, typed lines and snapshots, separate chargeable/donation/cash-due totals. Server stores its assigned invoice ID, received timestamp, and uploader email. API validates line values and recomputes totals.
9. **Catalog seed:** use a tracked database migration to seed [`CATALOG.toml`](CATALOG.toml) once. Later migrations/app starts must not overwrite product edits or reactivate disabled products. New generated IDs must not collide with legacy seed IDs. The migration tool is an implementation choice.
10. **Offline and auth:** frontend authorization code with PKCE; stateless API validates bearer tokens. Runtime OIDC settings. Continue local checkout and queueing after access-token expiry using captured event-time identity; a fresh valid token is needed for upload. Email is used even when `email_verified` is false; accounts are manually provisioned.
11. **Invoice UI:** persist invoices for external analysis, but provide no invoice-history screen, reports, or export.
12. **Engineering handoff:** provide runnable setup/dev instructions, migrations/seeding, runtime OIDC docs, and relevant automated tests. See [README.md](README.md) and [REQUIREMENTS.md](REQUIREMENTS.md).
13. **Missing email claim:** reject invoice upload when a valid token has no usable `email` claim. Keep the pending submission queued; do not fall back to another claim or accept a client-supplied email.

## Status

All product decisions are resolved. Routine implementation choices are delegated as described in [README.md](README.md).

## Confirmed exclusions

No inventory, customer records, card/payment-terminal integration, receipt printer, cash denomination selection, in-app RBAC, live synchronization, invoice history/reports, offline page loading, or PWA precaching is required.
