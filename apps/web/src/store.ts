import { openDB, type IDBPDatabase } from 'idb';
import { totals } from './money';
import type { CartLine, InvoiceSnapshot, LedgerEntry, PersistedState } from './types';

const DB_NAME = 'sell-guy';
const STORE = 'state';
const KEY = 'current';

let dbPromise: Promise<IDBPDatabase> | undefined;
function database() {
  dbPromise ??= openDB(DB_NAME, 1, { upgrade(db) { db.createObjectStore(STORE); } });
  return dbPromise;
}

export function createInitialState(): PersistedState {
  return { active_cart: { cart_uuid: crypto.randomUUID(), lines: [] }, cash_balance_cents: 0, ledger: [], pending: [], email: null };
}

export async function loadState(): Promise<PersistedState> {
  const db = await database();
  const tx = db.transaction(STORE, 'readwrite');
  try {
    const existing = await tx.store.get(KEY);
    if (existing) {
      await tx.done;
      return existing;
    }
    const initial = createInitialState();
    await tx.store.put(initial, KEY);
    await tx.done;
    return initial;
  } catch (error) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw error;
  }
}

export async function updateState(update: (state: PersistedState) => PersistedState): Promise<PersistedState> {
  const db = await database();
  const tx = db.transaction(STORE, 'readwrite');
  try {
    const current = (await tx.store.get(KEY)) ?? createInitialState();
    const next = update(structuredClone(current));
    await tx.store.put(next, KEY);
    await tx.done;
    return next;
  } catch (error) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw error;
  }
}

export function recordDrawerChange(
  state: PersistedState,
  delta: number,
  reason: LedgerEntry['reason'],
  email: string | null,
  cartUuid?: string,
): PersistedState {
  if (delta === 0) return state;
  const balance = state.cash_balance_cents + delta;
  if (!Number.isSafeInteger(balance)) throw new RangeError('Drawer balance is out of range');
  const entry: LedgerEntry = {
    id: crypto.randomUUID(), created_at: new Date().toISOString(), delta_cents: delta,
    resulting_balance_cents: balance, reason, email, ...(cartUuid ? { cart_uuid: cartUuid } : {}),
  };
  return { ...state, cash_balance_cents: balance, ledger: [...state.ledger, entry] };
}

export function changeLineQuantity(line: CartLine, quantity: number): CartLine {
  const lineTotal = line.unit_amount_cents * quantity;
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(lineTotal)) throw new RangeError('Sale quantity or line total is out of range');
  return { ...line, quantity, line_total_cents: lineTotal };
}

export function queueActiveCart(state: PersistedState, savedAt = new Date().toISOString()): PersistedState {
  if (state.active_cart.lines.length === 0) return state;
  const summary = totals(state.active_cart.lines);
  const snapshot: InvoiceSnapshot = {
    schema_version: 1,
    cart_uuid: state.active_cart.cart_uuid,
    saved_at: savedAt,
    currency: 'EUR',
    lines: state.active_cart.lines.map(({ id: _id, ...line }) => line),
    chargeable_total_cents: summary.chargeable,
    donation_total_cents: summary.donations,
    cash_amount_due_cents: summary.due,
  };
  return {
    ...state,
    active_cart: { cart_uuid: crypto.randomUUID(), lines: [] },
    pending: [...state.pending, { snapshot, status: 'queued' }],
  };
}

export function discardActiveCart(state: PersistedState, email: string | null): PersistedState {
  if (state.active_cart.lines.length === 0) return state;
  const cartUuid = state.active_cart.cart_uuid;
  let next = state;
  for (const line of state.active_cart.lines) {
    next = recordDrawerChange(next, -line.line_total_cents, 'reversal', email, cartUuid);
  }
  return { ...next, active_cart: { cart_uuid: crypto.randomUUID(), lines: [] } };
}
