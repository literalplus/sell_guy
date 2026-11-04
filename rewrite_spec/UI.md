# UI and interaction brief

## Existing application

The main window is borderless and maximized (`_Sell/MainWindow.xaml`). It is a single-screen till:

- **Left/top:** 3×4 orange product/action tiles, with price and keyboard hotkey; four page controls sit below them. First-page special actions are `Sonstiges` (custom-priced item) and `Spende` (donation), followed by catalog products.
- **Left/bottom:** numeric display with a second line for optional cash balance; `SAVE`, `CE`, `GGB`, backspace, enter, and digit buttons. The hardware keyboard supports digit entry, Enter, Backspace, Delete/CE, period/save, Print Screen/save, arithmetic keys, and left/right page navigation. Tile hotkeys use Q/W/E, A/S/D, Y/X/C, R/F/V in row order (`_Sell/Action/GridHotKeys.cs`).
- **Right:** sale lines and total. Line text displays item, unit price, quantity, and extended price.
- **Footer:** one status message such as “Bereit!”, save status, or an error.
- **Context menus/tools:** Enter's menu contains minimize/close, Tools, and cash set/subtract. Tools opens Windows Explorer at the invoice folder or app folder (`Tools.xaml`, `Tools.xaml.cs`).

There is no separate navigation or configuration UI. The historic screenshot is outdated; use [`CATALOG.toml`](CATALOG.toml) for initial catalog data.

## Proposed web interaction

Use a responsive checkout as the default view, optimized for a touchscreen/tablet or desktop keyboard. Authentik provides OIDC sign-in, with token handling in the frontend. Use the current user's `email` claim for audit attribution even if `email_verified` is false; users are manually provisioned by admins. There are no in-app roles. Do not copy the legacy proportions/colors unless desired by the product owner.

1. **Catalog region:** visible product tiles with clear name and formatted price; search/category filters are not evidenced as needed and should be omitted unless catalog size grows. A product tile adds one unit. Fetch product configuration at page load; do not live-sync product edits into an already-loaded checkout. Refresh/reload fetches the latest catalog.
2. **Cart region:** item name, unit price, quantity, line total, decrement/increment or quantity editor, and remove action. Mixed-price custom items must not be merged into a misleading line. Show chargeable total, donations, and cash amount due distinctly.
3. **Cart recovery:** persist the active cart and restore it on the next successful app load, even if this requires coming back online to load the app. Restore original line snapshots and do not reapply cash effects on recovery. Persist cart, balance, ledger, and pending queue in one transaction. If persistence fails, do not reflect the edit as committed.
4. **Custom item:** an explicit control opens a small form/dialog with fixed description `Sonstiger Artikel` and amount. Require a strictly positive amount. Accept `12.34` or `12,34` with clear EUR labeling; reject grouping separators and more than two fractional digits; never round. Different amounts remain separate lines.
5. **Quantity:** use inline quantity editing or a clear quantity dialog. Do not depend on hidden “press multiply, then tile, but not Enter” state. Require a positive whole integer; cancellation leaves the cart unchanged.
6. **Donation:** keep a special action, require a strictly positive amount, and show it separately from chargeable goods. It increases the drawer balance and cash amount due, but not the chargeable invoice total. Donation-only carts are valid and savable.
7. **Change helper:** show chargeable invoice total, donation total, cash amount due (`chargeable + donations`), “Amount received”, and “Change due” distinctly. Handle an insufficient received amount visibly; this is only a calculation, not payment processing. E.g. €10 goods + €2 donation + €20 received = €8 change.
8. **Actions/status:** label sale actions clearly, e.g. `Speichern` and `Verwerfen`, so save and discard cannot be confused. Discard reverses this unsaved cart's cash-ledger changes exactly, even after manual drawer changes. Save durably queues an immutable snapshot under the cart UUID before sending; on save, start a new active cart. Keep uncertain submissions immutable and retry them with the same UUID/payload; the operator may continue using the new active cart. Show pending/stored/error status.
9. **Configuration:** provide a separate online settings view to maintain server-backed product name, display label, strictly positive price, and order/active status. Product editing is unavailable offline; fetch the latest catalog at page load only.
10. **Cash drawer and audit:** initialize balance to €0 and show current signed balance. Manual set accepts a signed target; manual subtract accepts a positive amount and may take the balance below zero. Provide a ledger/history view with signed delta, resulting balance, time, reason, and event-time email. Keep ledger browser-local; edits/removals/discard append exact inverse events.
11. **Offline status:** indicate connectivity and pending queue status. In the already-loaded page, checkout and queueing continue offline even after access-token expiry, attributed locally to the identity captured at authentication. Upload requires a fresh valid token. The persisted cart and queue restore the next time the app loads successfully; the app itself need not load offline. Do not implement PWA precaching.
12. **Invoices:** persist invoices in PostgreSQL, but do not add an invoice history/detail screen, reports, or export.

## Accessibility and state

Apply the validation rules in [REQUIREMENTS.md](REQUIREMENTS.md) consistently in every form. Buttons and dialogs should be keyboard reachable, have accessible names, and work at touch size. Maintain clear focus and announce cart-total/save-status changes to assistive technology. Persist the active cart, signed balance, ledger, and invoice queue atomically in browser-local storage (IndexedDB is recommended). Saving moves an active cart into immutable pending/saved state; the same cart UUID cannot be used for changed content.
