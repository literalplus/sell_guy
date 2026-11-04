export type LineKind = 'product' | 'custom' | 'donation';

export interface CartLine {
  id: string;
  kind: LineKind;
  product_id: number | null;
  description: string;
  unit_amount_cents: number;
  quantity: number;
  line_total_cents: number;
}

export interface Cart {
  cart_uuid: string;
  lines: CartLine[];
}

export interface LedgerEntry {
  id: string;
  created_at: string;
  delta_cents: number;
  resulting_balance_cents: number;
  reason: 'sale' | 'donation' | 'manual_set' | 'manual_subtract' | 'reversal';
  email: string | null;
  cart_uuid?: string;
}

export interface InvoiceSnapshot {
  schema_version: 1;
  cart_uuid: string;
  saved_at: string;
  currency: 'EUR';
  lines: Omit<CartLine, 'id'>[];
  chargeable_total_cents: number;
  donation_total_cents: number;
  cash_amount_due_cents: number;
}

export interface PendingInvoice {
  snapshot: InvoiceSnapshot;
  status: 'queued' | 'blocked';
  message?: string;
  invoice_id?: string;
}

export interface PersistedState {
  active_cart: Cart;
  cash_balance_cents: number;
  ledger: LedgerEntry[];
  pending: PendingInvoice[];
  email: string | null;
}

export interface Product {
  id: number;
  name: string;
  display_name: string | null;
  price_cents: number;
  position: number;
  enabled: boolean;
}

export interface ProductInput {
  name: string;
  display_name: string | null;
  price_cents: number;
  position: number;
  enabled: boolean;
}

export interface RuntimeConfig {
  issuer: string;
  client_id: string;
  audience: string;
  scope: string;
  redirect_uri: string;
  post_logout_redirect_uri: string;
}
