export function parseCurrencyToCents(input: string, allowZero = false): number | null {
  const value = input.trim();
  if (!/^(?:0|[1-9]\d*)(?:[.,]\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || (allowZero ? cents < 0 : cents <= 0)) return null;
  return cents;
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

export function totals(lines: { kind: string; unit_amount_cents: number; quantity: number }[]) {
  let chargeable = 0;
  let donations = 0;
  for (const line of lines) {
    const lineTotal = line.unit_amount_cents * line.quantity;
    if (!Number.isSafeInteger(lineTotal)) throw new RangeError('Sale line total is out of range');
    if (line.kind === 'donation') donations += lineTotal;
    else chargeable += lineTotal;
    if (!Number.isSafeInteger(chargeable) || !Number.isSafeInteger(donations)) throw new RangeError('Sale total is out of range');
  }
  const due = chargeable + donations;
  if (!Number.isSafeInteger(due)) throw new RangeError('Cash amount due is out of range');
  return { chargeable, donations, due };
}

export function changeDue(receivedCents: number, dueCents: number): number {
  return receivedCents - dueCents;
}
