import { describe, expect, it } from 'vitest';
import { changeDue, parseCurrencyToCents, totals } from './money';

describe('currency input and checkout arithmetic', () => {
  it.each([['12.34', 1234], ['12,34', 1234], ['12', 1200], ['0,05', 5]])('parses %s exactly', (input, expected) => {
    expect(parseCurrencyToCents(input)).toBe(expected);
  });

  it.each(['', '0', '-1', '1.234', '1,2,3', '1 000', '1,000'])('rejects invalid amount %s', input => {
    expect(parseCurrencyToCents(input)).toBeNull();
  });

  it('includes donations in cash due and change, but not the invoice total', () => {
    const result = totals([
      { kind: 'product', unit_amount_cents: 1000, quantity: 1 },
      { kind: 'donation', unit_amount_cents: 200, quantity: 1 },
    ]);
    expect(result).toEqual({ chargeable: 1000, donations: 200, due: 1200 });
    expect(changeDue(2000, result.due)).toBe(800);
  });
});
