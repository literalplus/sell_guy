# Data model and persistence

This document specifies the rewrite model. The legacy app had explicit `Product` and `Price` classes, but its cart and invoices were implicit UI lists. Code paths in this document's history are provenance only; use the catalog snapshot and rules here when implementing from a copied `rewrite/` folder.

## Product configuration (PostgreSQL)

- `Product`: integer primary key, name, optional display label, strictly positive price in integer cents, position, enabled flag.
- Seed all 13 entries from [`CATALOG.toml`](CATALOG.toml) in a tracked database migration. Seed products are enabled and retain their legacy IDs and order. The seed migration runs once; later app starts/migrations must not reset operator-edited values or re-enable disabled products.
- Use a sequence/default for future integer product IDs and advance it above the largest seed ID (23) so new products cannot collide. The implementer chooses the migration tool and documents how to run it.
- PostgreSQL is authoritative. Fetch the catalog on page load and do not live-update an already-loaded session. Editing requires connectivity.

## Active cart and browser-local state

`ActiveCart` has a UUID generated and persisted before its first sale line, plus line snapshots. Do not reconstruct a recovered line's price or description from the current catalog.

Each `CartLine` has:

- `kind`: `product`, `custom`, or `donation`.
- `product_id` for catalog products; null for custom/donation.
- Description snapshot. Custom description is fixed as `Sonstiger Artikel`; donation is labelled `Spende`.
- `unit_amount_cents` strictly greater than zero and positive whole `quantity` (donations use quantity 1, with the entered donation as their amount).
- Derived `line_total_cents = unit_amount_cents * quantity`.

Catalog and custom lines are chargeable. Donation lines are not chargeable. Keep distinct custom entries at different prices as separate lines. Derive:

- `chargeable_total_cents`: sum of product and custom line totals.
- `donation_total_cents`: sum of donation line totals.
- `cash_amount_due_cents = chargeable_total_cents + donation_total_cents`.

Persist and recover the active cart in browser-local storage. Also persist the signed cash balance, append-only local audit ledger, and pending invoice submissions. Use one IndexedDB transaction for any operation that changes more than one of these (e.g. add/remove a line, adjust drawer, discard cart, move a cart to pending) so an interrupted write cannot leave the cart and drawer effects inconsistent. If a storage transaction fails, leave the visible state unchanged and do not claim the operation was saved. On recovery, restore the cart and ledger exactly; never apply its already-recorded drawer effects again.

The browser-local drawer model contains:

- `cash_balance_cents`: signed integer cents; it starts at zero and may become negative.
- `CashLedgerEntry`: stable ID, timestamp, signed `delta_cents`, resulting signed balance, reason (`sale`, `donation`, `manual set`, `manual subtract`, `reversal`), and event-time email claim when available.
- Sale/donation additions adjust the balance at line-add time. Removing/reducing a line or discarding an unsaved cart appends exact inverse deltas, even if manual adjustments intervened. Manual set accepts a signed target and records `target - current`; manual subtract accepts a positive amount and records its negative delta. No clamping or partial reversal.

This ledger is local to one browser profile and is best-effort audit history: it is not shared to PostgreSQL and is not tamper-evident. The UI exposes its entries and current balance.

## Invoice storage and API contract

Invoices are informational records stored for external analysis; the app has no invoice history, reports, or export. There are no statutory VAT or sequential-number requirements.

Minimal PostgreSQL shape:

- `invoice_id`: server-assigned primary key (UUID or equivalent).
- `cart_uuid`: client-generated UUID, unique constraint, used only for idempotency; it is not the invoice primary key.
- `received_at`: server `timestamptz` when the API accepts the invoice.
- `total_cents`: chargeable invoice total, in integer cents.
- `data`: JSONB snapshot with `schema_version`, `cart_uuid`, client save-event timestamp (`saved_at`), currency, lines, `chargeable_total_cents`, `donation_total_cents`, `cash_amount_due_cents`, and server-derived `uploaded_by_email`.

The client persists an immutable pending submission before the first request. The same `cart_uuid` and identical client payload retried any number of times creates only one row and returns the existing server invoice ID. If an existing UUID is submitted with a different payload, return a conflict and do not overwrite the original. Mark that pending item blocked, stop automatic retries, retain it for diagnosis, and show an error; the operator may continue a separate active cart. The initial successful upload sets `uploaded_by_email`; an idempotent retry never overwrites that attribution. A pending snapshot with uncertain outcome cannot be edited or resubmitted under a new UUID. Keep the snapshot queued after network errors and retry it unchanged. Remove it from the local pending queue only after a successful server response has been persisted locally; if that local acknowledgement write fails, retry with the same UUID.

Saving transitions state atomically: persist the pending snapshot and replace the active cart with a new empty cart/new UUID in the same browser-storage transaction. This prevents accidental resubmission. Discard applies compensating ledger entries, clears the discarded cart, and initializes a fresh active cart UUID in the same transaction. Pending submissions with uncertain server outcome are immutable and are not treated as an editable/discardable active cart.

The API validates line kinds, positive amounts/quantities, timestamps/schema shape, and all declared totals by recomputing from lines. It must not trust client-declared totals or uploader identity. Validate totals against the submitted price/description snapshots; do not replace snapshots with current catalog values at upload time, since an offline sale may predate a catalog edit. On successful insert, obtain uploader email from the validated bearer token and store it in the invoice JSON. A later uploader may differ from the identity recorded on offline local ledger events; uploader identity is authoritative for the server invoice, and there is no original-operator matching requirement. If the validated token has no usable `email` claim, reject upload and leave the pending submission queued; see [DECISION_LOG.md](DECISION_LOG.md).

### Invoice snapshot examples

These are client snapshot examples (the server adds `invoice_id`, `received_at`, and `uploaded_by_email` when storing). Field names can be adjusted as long as the stated semantics remain.

Ordinary sale: two €4.00 products and one €2.50 custom item.

```json
{
  "schema_version": 1,
  "cart_uuid": "b8e89f4e-6940-4d76-8bb6-d0985a21f057",
  "saved_at": "2026-11-04T12:30:00Z",
  "currency": "EUR",
  "lines": [
    { "kind": "product", "product_id": 1, "description": "Heißer Löwe", "unit_amount_cents": 400, "quantity": 2, "line_total_cents": 800 },
    { "kind": "custom", "product_id": null, "description": "Sonstiger Artikel", "unit_amount_cents": 250, "quantity": 1, "line_total_cents": 250 }
  ],
  "chargeable_total_cents": 1050,
  "donation_total_cents": 0,
  "cash_amount_due_cents": 1050
}
```

Donation-only sale: no chargeable lines and a €2.00 donation. It is saveable, with zero invoice total and €2.00 cash due.

```json
{
  "schema_version": 1,
  "cart_uuid": "5661fc31-ff9a-4748-a990-3d4a0e619b27",
  "saved_at": "2026-11-04T12:35:00Z",
  "currency": "EUR",
  "lines": [
    { "kind": "donation", "product_id": null, "description": "Spende", "unit_amount_cents": 200, "quantity": 1, "line_total_cents": 200 }
  ],
  "chargeable_total_cents": 0,
  "donation_total_cents": 200,
  "cash_amount_due_cents": 200
}
```

## Validation and input representation

- Prices and donation amounts are strictly positive integer cents; quantities are positive whole numbers.
- For product, custom-item, donation, and amount-received currency fields, accept either dot or comma as the decimal separator (e.g. `12.34`, `12,34`). Reject grouping separators, empty values, negative values, and more than two fractional digits; prices/donations must be strictly positive while amount received may be zero. Never round fractional cents.
- Manual drawer set uses the same decimal syntax but accepts a signed target balance; manual subtract accepts a strictly positive amount. These operations can result in a negative drawer balance.
- Empty carts cannot be saved. Donation-only carts are valid.
- Use integer-cent calculations throughout; do not use binary floating point.

## OIDC and local identity

Authentik OIDC values (issuer, client, audience/scopes, redirect URLs) are runtime configuration. The frontend uses authorization code with PKCE and handles tokens; the stateless Rust API validates bearer tokens. Use the token's `email` claim for audit even if `email_verified` is false; users are manually provisioned by admins. Local ledger events use the email claim captured when the event happened, including offline work after access-token expiry. An invoice is attributed server-side to the email claim on the valid token used for upload, even if this differs from the locally captured email. The API must not accept a client-supplied email as authoritative. If the email claim is missing, behavior is unresolved. No backend sessions or in-app roles.

## Migration and implementation boundaries

- Do not import legacy receipts, invoice numbering, or cash files.
- Use a tracked database migration to create tables and seed `CATALOG.toml` once. Subsequent application starts and migration runs must not overwrite operator edits or reactivate disabled products. New product IDs must not collide with seed IDs.
- The app supports online initial loading followed by offline use in the loaded page. The active cart and pending invoice queue survive browser restarts and restore on the next successful app load. Offline loading of the app itself, offline page refresh, and PWA precaching are not required.
- The implementing agent chooses ordinary engineering details (migration library, API route names, frontend libraries/component organization), and documents how to run migrations and configure OIDC at runtime.
