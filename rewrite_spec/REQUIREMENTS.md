# Requirements and acceptance criteria

## Core workflows

### Configure and browse products

**Confirmed (legacy):** `_Sell/Service/DefaultProductRegistry.cs` defines 13 products with integer IDs, names, euro prices, and optional display labels. `_Sell/Action/ProductGrid.cs` and `ProductGridPage.cs` place actions in a 3-column by 4-row grid; the first page also contains `Sonstiges` and `Spende`, leaving three catalog products on the second page. Page navigation wraps at either end. Product buttons show a name, price, and keyboard shortcut (`_Sell/Action/GridHotKeys.cs`). The catalog is compiled into the app, not edited in a settings screen.

**Decision:** products are server-owned PostgreSQL data, maintained in a settings screen. Seed the 13 products in [`CATALOG.toml`](CATALOG.toml) through a one-time tracked migration on a fresh database; this is the verified current catalog snapshot, and the screenshot is obsolete. Keep the `Sonstiges` and `Spende` special actions.

**Decision (web):** fetch the authoritative catalog from PostgreSQL on page load and cache it for the loaded app session. Product edits are persisted server-side; other loaded sessions do not receive live updates, and a page reload is needed to fetch the latest catalog. Product editing requires connectivity.

### Build and edit a sale

**Confirmed (legacy):** selecting a regular product adds one unit. The item list groups quantities by product `Name`; each click/order operation is also retained separately. The displayed line includes name, unit price, quantity, and extended price; the total is incremented in integer minor units (`_Sell/MainWindow.xaml.cs:101-105, 154-207`). `Price` stores integer cents and formats as euro with comma decimal separator (`_Sell/Model/Price.cs`).

The keypad appends digits to a numeric display; physical number keys and numpad work too. Backspace removes the last digit, the context-menu “Auf Null setzen” resets the entry, and `CE`/Delete removes the most recently added item operation (or clears an already-empty cart) (`MainWindow.xaml:82-159`, `MainWindow.xaml.cs:455-500`). A separate clear-all handler exists but is not directly exposed as a main button.

The `×` keyboard action captures the current integer as a quantity; selecting a product then adds that quantity. The `ENTER` key while waiting for multiplication instead evaluates a number multiplication in the display, so it does not add a product. Other add/subtract/divide handlers implement display arithmetic but are not ordinary sale actions. `GGB` subtracts the current sale total from the amount entered and displays the difference; it is a calculation only, not a payment transaction (`MainWindow.xaml.cs:257-316, 532-600`).

`Sonstiges` prompts for an amount and adds a line named `Sonstiger Artikel`; the amount is interpreted as cents (e.g. `250` means €2.50), because it is passed directly to `Price(int rawValue)` (`MainWindow.xaml.cs:209-223`). `Spende` similarly prompts for an integer-cent amount (`:324-338`).

**Decision:** custom items retain the fixed description `Sonstiger Artikel`; multiple custom entries with different prices remain separate lines. `Spende` remains a distinct informational line in the cart and saved invoice data, but is excluded from invoice total and added to the cash-drawer balance. The legacy code excludes donation from both total and drawer; the rewrite must implement this clarified intention.

**Decision (web):** the cart is an explicit list of snapshot lines, persisted in browser storage with a stable cart UUID and restored on the next successful app load. Each line has quantity controls and a remove action; removal or reducing quantity changes only that line. Cart changes and their corresponding signed drawer-balance/ledger changes must be atomic. Removing a line or discarding the cart appends exact compensating ledger entries; recovery must not apply the effects again. Use integer cents end-to-end and recalculate chargeable totals from lines.

### Complete / save a sale

**Confirmed (legacy):** `SAVE` (also `.` or Print Screen) writes `rechnung_NNNN_yyyy-MM-dd_HHmm.txt` under the per-user AppData `.../.xxyy/_sell/rechnungen/` directory, with date/time, line text, total and a thank-you footer (`MainWindow.xaml.cs:386-424`; `App.xaml.cs:19-24`). The invoice number starts from a small text config and increments after save. The in-progress list is cleared after the save attempt, including when an exception is caught. No receipt printer is invoked.

**Decision:** save informational invoices to PostgreSQL, with no statutory invoice/VAT requirements and no required sequential human numbering. The server assigns the invoice primary key; a client-generated cart UUID is a distinct, unique idempotency key. Store a received timestamp, chargeable total cents, and JSON snapshot. JSON contains a schema version, cart UUID, save-event time, line-kind and product/description/price/quantity snapshots, chargeable and donation totals, and cash amount due. The server derives uploader email from the valid bearer token.

**Decision (web):** before the first save request, durably persist an immutable pending snapshot under the cart UUID and transfer the cart into the pending/saved lifecycle; create a fresh active cart UUID so the submitted sale cannot accidentally be resubmitted as a new sale. Offline save means the snapshot is durably queued, not that the server has stored it. Retry the exact same snapshot and UUID after uncertain outcomes. A repeated UUID and identical payload returns the existing server ID; a repeated UUID with a different payload is a conflict, never overwrites the original, and is retained as blocked for diagnosis without automatic retry. Keep the pending snapshot on storage/API failure; if the browser storage write fails, do not clear the cart or report local save success. An uncertain pending submission cannot be edited; the operator can continue with a separate active cart. The app provides no invoice history or reports.

## Business rules and anomalies

- **Money:** legacy prices and totals are integer euro cents. No tax/VAT, discounts, rounding policy, or fractional quantities are implemented. Use integer minor units; do not use binary floating-point for money.
- **Quantity:** regular product button adds one; multiplication mode adds the captured integer quantity when a product is selected. The legacy code does not validate quantity as positive; zero/negative values can arise via arithmetic/display paths. The rewrite rejects zero and negative quantities and accepts positive whole quantities only.
- **Custom item grouping defect:** every custom item is named `Sonstiger Artikel`. The old cart groups by name and overwrites the displayed unit price while summing operation totals. Adding custom items at different prices can therefore show a line extension that does not agree with the sale total. Proposed cart lines should preserve each entered price or group only when unit prices match.
- **Donation discrepancy:** donation uses `AddItemToLists(..., addToTotal: false)` (`MainWindow.xaml.cs:324-330`): it appears as a line priced at the entered amount and contributes zero to total and cash balance. The owner clarified that the intended behavior is to exclude it from invoice total while increasing cash-drawer balance; implement that clarified rule.
- **Undo/cash discrepancy:** legacy undo subtracts the last operation's amount from total and cash, even if cash logging is disabled (`MainWindow.xaml.cs:351-379`). For custom items, grouped line price/quantity may become inaccurate; donation undo uses a zero bookkeeping amount. The rewrite must use line-based reversal and record exact inverse ledger deltas, including after intervening manual balance changes.
- **Undo crash at default setup:** cash logging is disabled when the stored balance is `-1`; in that state `_cash` is never initialized (`MainWindow.xaml.cs:107-118`). Undo nevertheless dereferences `_cash` unconditionally at `:374`, so undoing a sale can throw. The product-index map also is not adjusted after removing a row, so later cart updates can address the wrong displayed row (`:169-206, 351-379`). These are defects, not intended rules.
- **Cash drawer:** required. Legacy balance is an integer in `cash.int.cfg.txt`; regular sale items added through `AddPriceToList` increase it, and context-menu actions set an absolute amount or subtract a typed amount (`MainWindow.xaml.cs:107-138, 225-255, 579-587`; `App.xaml.cs:65-89, 117-139`). Start at €0. Drawer balances and ledger deltas are signed cents and may become negative. Sale/donation additions, manual adjustments, removals, and discard append exact signed events; setting the balance is an adjustment event. The ledger stays browser-local and has a view. No payment terminal or tender-record workflow is wanted.
- **Amount received/change:** payments are cash and not processed or recorded. `cash amount due = chargeable invoice total + donation total`; `change due = amount received - cash amount due`. Show an insufficient received amount visibly when change is negative. For example, €10 goods + €2 donation with €20 received means €8 change, while the chargeable invoice total remains €10. Focusing the amount-received field allows normal text/keyboard input. A toggle beside the field opens a quick-input overlay with euro coin and banknote denominations; each tap adds that denomination to the received amount. F2 also opens the same view, and the toggle or Escape closes it.
- **Receipt defects:** invoice text generation writes the UI's header/separator rows as if they were sale lines (`MainWindow.xaml.cs:401-408`). The file name has minute precision and may collide/overwrite; there is no collision handling. A list-length mismatch returns before closing the file, while the method still reaches clear-all. These are implementation defects, not target requirements.
- **Catalog evidence conflict (resolved):** the current catalog is captured in [`CATALOG.toml`](CATALOG.toml); the screenshot is outdated.

## Acceptance criteria for the web core

1. An authenticated operator can manage products (name, strictly positive price in cents, optional display name, ordering/active status) through the settings UI; all authenticated users have the same access because there are no in-app roles. Changes persist in PostgreSQL. A tracked migration seeds the 13 enabled catalog entries once, does not overwrite later edits/reactivate disabled items, and initializes generated integer IDs above the largest legacy seed ID (23).
2. Product prices, custom-item prices, and donation amounts are strictly positive integer cents. Quantities are positive whole numbers. Currency input accepts `12.34` and `12,34`, rejects grouping separators and more than two fractional digits, and never rounds. Empty carts cannot be saved; donation-only carts can be saved with zero chargeable total and positive donation total.
3. The operator can select products, enter quantities, and add fixed-description custom items. Differently priced custom items remain separate lines. Chargeable total, donation total, and cash amount due are separately displayed/calculated exactly in cents.
4. The active cart has a stable UUID and is persisted with its line snapshots, quantities, donation data, and drawer state. On next successful app load it is restored without applying cash effects a second time. Adding/removing/changing quantities updates cart, balance, and ledger atomically. Discarding the cart appends exact compensating ledger deltas and clears the persisted active cart, even if manual adjustments happened after the sale entries.
5. The operator can distinguish `Speichern` (save) from `Verwerfen` (discard). Discard reverses unsaved sale/donation effects. Invalid or cancelled numeric input cannot create a malformed line.
6. The cash balance starts at €0, is signed, and may become negative. Sale and donation additions update it; manual set/subtract actions are permitted at any time. Every change has a signed ledger delta and resulting balance. Cart recovery does not duplicate effects.
7. Change due uses chargeable total plus donation total. For €10 of goods plus a €2 donation and €20 received, show €8 change; do not record payment.
8. Invoice submission has an immutable snapshot and a stable client cart UUID before the first request. The server creates a distinct invoice primary key and enforces cart-UUID uniqueness. An identical retry returns the same invoice ID; a conflicting payload with that UUID is rejected without overwrite. Network uncertainty preserves the pending snapshot; failed browser-storage writes do not clear the cart or claim it was queued.
9. Invoice records distinguish client save-event time from server receipt time. The API validates line kinds, positive amounts/quantities, and all derived totals. Donation-only invoices are valid; empty invoices are rejected. Server-side invoice attribution is the email claim of the valid token used for upload; local ledger entries retain the identity captured when the event happened.
10. OIDC settings (issuer, client, redirect, audience/scopes) are supplied at runtime. The frontend uses authorization code with PKCE; the stateless Rust API validates bearer tokens. `email` is used even if `email_verified` is false; manually provisioned users and one concurrent user are expected. A missing-email claim behavior remains to be decided.
11. Offline cart editing and invoice queueing work in the already-loaded page after token expiry, and cart recovery occurs when the app next loads successfully. Upload requires a fresh valid token. Offline application loading/PWA precaching is out of scope.
12. No invoice history/report UI, inventory, customer records, card processing, external POS hardware, receipt printer, or denomination selection is required.

### Validation rules

| Input/operation | Rule |
|---|---|
| Catalog product price | Strictly positive integer cents; enforce in settings UI and API. |
| Custom-item price | Strictly positive; accept `12.34` or `12,34`; reject thousands/grouping separators and more than two fractional digits; never round. |
| Donation amount | Strictly positive; same currency parser as custom items. |
| Quantity | Positive whole number only; reject zero, negative, and fractional values. |
| Save | Reject an empty cart. A donation-only cart is valid; its chargeable total is zero. |
| Manual drawer set/subtract | Set accepts a signed target balance and records `target - current` as delta. Subtract takes a positive amount and records its negative as delta. Balance may be negative. |
| Received cash | Optional change-helper input; use the same dot/comma decimal parser and calculate change without recording a payment. |
| Derived totals | API computes totals from validated lines and rejects inconsistent client-declared totals. No binary floating-point money calculations. |

Integer overflow is not a product-specific validation concern; use appropriate integer types and normal safe parsing/calculation behavior.

### Required implementation handoff

The implementing agent should provide runnable setup/development instructions, database migrations and seed behavior, runtime OIDC configuration documentation, and relevant automated checks. In particular, test cart recovery without duplicate cash effects, exact reversals after manual adjustments, idempotent retries/conflicting UUID payloads, donation-inclusive change calculation, donation-only invoice saves, validation/empty-cart behavior, and once-only seeding that preserves edits.
