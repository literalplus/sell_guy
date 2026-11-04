import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createInitialState, discardActiveCart, loadState, queueActiveCart, recordDrawerChange, updateState } from './store';

beforeEach(() => {
  vi.stubGlobal('crypto', { ...crypto, randomUUID: () => `${Math.random()}` });
});

describe('browser persistence and drawer reversals', () => {
  it('recovers persisted state without applying drawer effects again', async () => {
    const initial = await loadState();
    expect((await loadState()).active_cart.cart_uuid).toBe(initial.active_cart.cart_uuid);
    await updateState(state => recordDrawerChange({ ...state, active_cart: { ...state.active_cart, lines: [{ id: 'line', kind: 'product', product_id: 1, description: 'Drink', unit_amount_cents: 500, quantity: 1, line_total_cents: 500 }] } }, 500, 'sale', 'operator@example.test', initial.active_cart.cart_uuid));
    const recovered = await loadState();
    expect(recovered.cash_balance_cents).toBe(500);
    expect(recovered.ledger).toHaveLength(1);
    expect(recovered.active_cart.lines).toHaveLength(1);

    await Promise.all([
      updateState(current => recordDrawerChange(current, 100, 'manual_set', null)),
      updateState(current => recordDrawerChange(current, 100, 'manual_set', null)),
    ]);
    const afterConcurrentChanges = await loadState();
    expect(afterConcurrentChanges.cash_balance_cents).toBe(700);
    expect(afterConcurrentChanges.ledger).toHaveLength(3);
  });

  it('records an exact cart reversal after a manual drawer adjustment', () => {
    let state = createInitialState();
    const cartUuid = state.active_cart.cart_uuid;
    state = { ...state, active_cart: { ...state.active_cart, lines: [{ id: 'line', kind: 'product', product_id: 1, description: 'Drink', unit_amount_cents: 500, quantity: 1, line_total_cents: 500 }] } };
    state = recordDrawerChange(state, 500, 'sale', null, cartUuid);
    state = recordDrawerChange(state, -500, 'manual_set', null);
    state = discardActiveCart(state, null);
    expect(state.cash_balance_cents).toBe(-500);
    expect(state.ledger.map(entry => entry.delta_cents)).toEqual([500, -500, -500]);
    expect(state.ledger.at(-1)?.resulting_balance_cents).toBe(-500);
    expect(state.active_cart.lines).toHaveLength(0);
  });

  it('moves the exact cart snapshot into the pending queue before a fresh cart starts', () => {
    const state = createInitialState();
    const cartUuid = state.active_cart.cart_uuid;
    const withLine = { ...state, active_cart: { ...state.active_cart, lines: [{ id: 'ui-only', kind: 'donation' as const, product_id: null, description: 'Spende', unit_amount_cents: 200, quantity: 1, line_total_cents: 200 }] } };
    const queued = queueActiveCart(withLine, '2026-11-05T12:00:00.000Z');
    expect(queued.pending[0].snapshot.cart_uuid).toBe(cartUuid);
    expect(queued.pending[0].snapshot.lines[0]).not.toHaveProperty('id');
    expect(queued.pending[0].snapshot.cash_amount_due_cents).toBe(200);
    expect(queued.active_cart.cart_uuid).not.toBe(cartUuid);
    expect(queued.active_cart.lines).toHaveLength(0);
  });
});
