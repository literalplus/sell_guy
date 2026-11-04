# Rewrite guide review and follow-up decisions

> Review history only. Decisions have been consolidated into `REQUIREMENTS.md`, `UI.md`, `DATA.md`, and `DECISION_LOG.md`; follow those documents if wording differs. The missing-email behavior is resolved in `DECISION_LOG.md`.

## Overall assessment

The rewrite folder is a strong, largely self-contained implementation brief. Its core scope is consistent, the catalog snapshot removes the need to inspect the legacy repository, and the acceptance criteria give an implementing agent useful observable outcomes. Legacy defects are generally distinguished clearly from intended behavior.

The main gaps concerned drawer accounting, recovery of unsaved carts, save/retry semantics, and the invoice data contract. The product-owner decisions below resolve most of those gaps. They must be propagated into the other documents before the guide is handed to an implementing agent.

This review covered all six original files in this folder. No legacy source inspection was needed. References below identify the reviewed sections; line numbers may change as the guide is revised.

## 1. Drawer balance and reversals

**Finding:** Exact reversal of cart effects conflicts with clamping the drawer balance at zero while permitting manual adjustments at any time. For example, adding a €5 item, manually setting the drawer to €0, and then discarding the cart requires a −€5 balance to preserve an exact reversal.

**Decision:** Drop clamping. The drawer balance may become negative. Preserve exact signed changes and compensating ledger entries rather than introducing partial-reversal logic.

**Required updates:**

- Remove the nonnegative-balance invariant and all zero-clamping requirements.
- Represent the balance and ledger deltas as signed integer cents.
- Removing a line, reducing its quantity, or discarding a cart must reverse the corresponding sale/donation effects exactly, even after manual drawer adjustments.
- Keep the displayed balance and ledger's recorded deltas/results consistent.

**Affected sections:** `REQUIREMENTS.md` “Build and edit a sale,” “Cash drawer,” and acceptance criteria; `UI.md` “Cash drawer and audit”; `DATA.md` “Cash drawer and audit ledger”; `DECISION_LOG.md` decision 5.

## 2. Persist and recover the active cart

**Finding:** The current guide keeps the active cart only in memory while immediately persisting its drawer effects. Reloading can therefore erase the cart without reversing its cash effects or creating an invoice.

**Decision:** Persist the active cart in browser local storage or IndexedDB. Unsaved-cart recovery is now in scope.

**Required updates:**

- Restore the unsaved cart when the app next loads successfully.
- Restore its existing identity, line snapshots, quantities, and donation data; do not reconstruct prices from the latest catalog.
- Recovery must not apply the cart's drawer effects a second time.
- Keep cart persistence and corresponding drawer/ledger changes consistent across interrupted writes. The agent may choose local storage or IndexedDB, but must explain how its storage design achieves this.
- Saving must transfer the cart into the pending/saved lifecycle without leaving it available for accidental resubmission as a new sale. Discarding must reverse its effects and clear the persisted active cart.
- This change does not by itself require offline app loading, PWA precaching, or offline page-refresh support. Recovery can occur when the app next loads online.

**Affected sections:** `README.md` scope; `REQUIREMENTS.md` acceptance criterion 9; `UI.md` offline behavior and accessibility/state; `DATA.md` “Active cart” and persistence boundaries; `DECISION_LOG.md` decision 3.

## 3. Identity for uploaded invoices

**Finding:** The original guide combines offline attribution to the initially authenticated operator with server-side identity derived from the token used to upload. It does not distinguish those identities when they differ.

**Decision:** The uploader's identity is sufficient for the server-stored invoice. Do not add original-operator matching or cross-user upload restrictions for this case.

**Required updates:**

- Attribute uploaded invoices to the `email` claim from the valid bearer token used for upload, regardless of `email_verified`.
- Do not trust a client-supplied email as the authoritative invoice actor.
- Browser-local ledger events can continue using the identity captured when the local event occurred, including during offline token expiry. Distinguish this local audit attribution from server-side invoice attribution.
- State what happens if the validated token has no usable `email` claim; that small authentication-contract detail remains unspecified.

**Affected sections:** `REQUIREMENTS.md` authentication/offline acceptance criteria; `DATA.md` invoice fields and OIDC paragraph; `DECISION_LOG.md` identity guidance.

## 4. Server invoice IDs and client-side deduplication

**Finding:** Stable retry identifiers are required, but the current guide does not fully define uncertain outcomes, such as a committed invoice whose success response is lost. Keeping an editable cart after such a failure can lead to inconsistent retries.

**Decision:** The server assigns the invoice ID. A client-generated cart UUID is the deduplication key and remains stable across retries. These are two distinct identifiers.

**Required updates:**

- Assign and persist a cart UUID before the first save attempt. Preserve it through cart recovery and queue/upload retries.
- Enforce uniqueness of the cart UUID in PostgreSQL. Repeated or concurrent submissions with that UUID must create only one invoice and return the existing server-assigned invoice ID.
- Remove instructions that make a client-generated ID the invoice primary key.
- Keep a durable snapshot of a pending submission so loss of a response does not force creation of a new cart UUID.
- Define when the submitted snapshot becomes immutable, what the operator may do while its outcome is uncertain, and how conflicting payloads under the same UUID are handled. Deduplication alone does not define those state transitions.
- A failed browser-storage write must not clear the cart or report that an invoice was saved locally.

**Affected sections:** `REQUIREMENTS.md` “Complete / save a sale” and acceptance criteria 6/9; `DATA.md` “Saved invoice.”

## 5. Donations and change due

**Finding:** Donations increase drawer balance but are excluded from the invoice's chargeable total. Calculating change from that total alone would tell the operator to return the donation.

**Decision:** Include donations in the change calculation so the operator knows what to actually give back.

**Required behavior:**

- `cash amount due = chargeable invoice total + donation total`.
- `change due = amount received − cash amount due`.
- Keep the chargeable invoice total separate from the cash amount due in the UI and saved data where needed.
- Example: €10 of goods plus a €2 donation, with €20 received, means €8 change. The chargeable invoice total remains €10.
- Continue displaying an insufficient amount received visibly; the helper remains a calculation rather than payment processing.

**Affected sections:** `REQUIREMENTS.md` “Amount received/change” and acceptance criterion 5; `UI.md` donation/change helper; `DATA.md` invoice representation.

## 6. Numeric and save validation

**Finding:** Positive whole quantities are specified, but price/donation validity, fractional cents, and empty-sale behavior are not fully defined.

**Decisions:**

- Quantities must be positive whole numbers.
- Product prices, custom-item prices, and donation amounts must be strictly positive; zero and negative values are invalid.
- Fractional cents are not permitted. Reject them rather than silently rounding.
- Empty carts cannot be saved.
- Donation-only carts can be saved. Their chargeable total is zero and their donation total is positive.
- Integer overflow is not a relevant product concern for this rewrite; no additional product-specific overflow policy is requested.

**Required updates:** Put these rules in a compact validation table and apply them consistently in the UI and API. Preserve exact integer-cent money handling and cancellation behavior. Explicitly specify accepted decimal separators for currency entry; the guide currently shows a dot example while describing comma-formatted legacy currency.

These positive-price rules do not reintroduce a nonnegative drawer-balance requirement: the drawer balance and its adjustment deltas are separate concepts.

**Affected sections:** `REQUIREMENTS.md` business rules and acceptance criteria; `UI.md` custom-item, quantity, and donation forms; `DATA.md` product/cart/invoice constraints.

## 7. Define a minimal invoice data contract

**Finding:** A completely free-form JSON representation leaves required semantics underspecified. The proposed cart line has no explicit donation discriminator, timestamp meaning is unclear during delayed upload, and the API's total-validation responsibility is not stated.

**Decision:** Tighten the contract while retaining the small PostgreSQL model and JSON snapshots.

**Recommended contract content:**

- A JSON schema/version field.
- Server-assigned invoice ID and unique client-generated cart UUID.
- Separate definitions for the checkout/save event time and server receipt time, so offline uploads do not silently become sales at upload time.
- Server-verified uploader attribution, as decided above.
- Explicit line kind: catalog product, custom item, or donation.
- Product reference when applicable, description snapshot, unit amount in cents, and positive whole quantity.
- Chargeable total and donation total, with the cash amount due defined as their sum.
- API validation of line shape, numeric rules, and consistency of derived totals. Historical snapshots must remain independent of later catalog edits.

Provide one ordinary-sale example and one donation-only example. The implementing agent can choose the exact field names and internal types once these semantics are fixed.

**Affected sections:** `DATA.md` “Active cart” and “Saved invoice”; corresponding acceptance criteria in `REQUIREMENTS.md`.

## 8. One-time catalog seeding through migrations

**Finding:** “Seed at database initialization” should explicitly preserve subsequent operator edits and avoid repeated insertion or restoration of seed values.

**Decision:** Use a database schema migration tool. Its migration history handles the only-once aspect of initial catalog seeding.

**Required updates:**

- Include the `CATALOG.toml` seed through a tracked migration for a fresh database.
- Subsequent application starts and migration runs must not overwrite edited prices/names or reactivate disabled products.
- State the initial enabled status of seeded products.
- Ensure creation of future products cannot collide with the seed's legacy IDs.
- The implementing agent may select the migration tool and document how migrations are run.

**Affected sections:** `README.md` implementation brief; `REQUIREMENTS.md` catalog configuration; `DATA.md` product configuration and migration.

## Agent-readiness improvements

### Reconcile the documents

The review's decisions have been recorded in requirements/UI/data and `DECISION_LOG.md`. Remove superseded requirements for zero clamping, memory-only carts, and client-generated invoice primary keys.

Add a short precedence rule: explicit rewrite decisions override legacy observations; acceptance criteria govern required behavior; proposed UI/model details allow implementation latitude unless explicitly required.

### Fix misleading wording

- In `UI.md` “Existing application,” replace the instruction to use the “current code catalog” with a direct reference to `CATALOG.toml`.
- Replace “store invoices in PostgreSQL only” with wording that distinguishes permanent server storage from the required durable browser queue.
- Keep the scope distinction clear: persisted-cart recovery is required, while offline loading of the application itself remains deferred.

### Define the implementation deliverables

Ask the implementing agent to supply:

- Runnable setup and development instructions.
- Database migrations and initial catalog seeding.
- Runtime OIDC configuration documentation.
- Relevant automated checks for the core behavior, especially cart recovery without duplicate cash effects, exact reversals after manual adjustments, retry deduplication, donation-inclusive change, and donation-only saves.

Explicitly delegate ordinary engineering choices such as libraries, API route naming, component organization, and migration tooling. Business behavior should be fixed by the guide; routine implementation choices should not require unnecessary clarification.

## Readiness conclusion

The folder communicates the intended application and provides enough catalog information to implement it independently of the legacy source. The decisions in this review, including the missing-email resolution, are consolidated in the current specification for the implementing agent.
