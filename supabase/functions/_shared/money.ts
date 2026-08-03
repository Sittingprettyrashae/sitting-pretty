// Money math for a booking, in ONE place so the API, the Stripe webhook, and
// the dashboard can never disagree about what has been paid or what is owed.
//
// PARITY: mirrors totalCentsFor / paidCents / balanceCentsFor / applyPayment /
// withMoney in server/server.mjs. If you change a rule here, change it there
// in the same commit.
//
// Her price strings are the source of truth:
//   "$150"  exact, so a fixed balance can be charged online.
//   "$50+"  (any price carrying a plus) means the final amount depends on the
//           client's hair, length, or add-ons. There is no fixed number to
//           charge, so the total is null and Ebony settles it in person.
//           A booking like that is NEVER offered an online balance.
//
// Nothing here reads or writes the database. paid_cents and paid_in_full are
// stored columns (see supabase/schema.sql); total and balance are always
// DERIVED, so they cannot drift from the payments that actually landed.

export interface MoneyBooking {
  price?: string | null;
  paid_cents?: number | null;
  paid_in_full?: boolean | null;
}

/** Full price in cents, or null when the price is variable ("$50+"). */
export function totalCentsFor(booking: MoneyBooking): number | null {
  const raw = String(booking.price ?? "");
  if (/\+/.test(raw)) return null;
  const m = raw.match(/\d+/);
  return m ? parseInt(m[0], 10) * 100 : null;
}

/** Everything that has landed so far: deposit, online balance, in person. */
export function paidCents(booking: MoneyBooking): number {
  return booking.paid_cents ?? 0;
}

/**
 * What the client can still pay online. null means there is nothing to offer:
 * already paid in full, or a variable price that is settled in person.
 */
export function balanceCentsFor(booking: MoneyBooking): number | null {
  if (booking.paid_in_full) return null;
  const total = totalCentsFor(booking);
  if (total == null) return null;
  const left = total - paidCents(booking);
  return left > 0 ? left : null;
}

/** Would this booking be settled once `newPaidCents` is the total paid? */
export function isPaidInFullAfter(booking: MoneyBooking, newPaidCents: number): boolean {
  const total = totalCentsFor(booking);
  return total != null && newPaidCents >= total;
}

export interface MoneyFields {
  paid_cents: number;
  total_cents: number | null;
  balance_cents: number | null;
  paid_in_full: boolean;
}

/** Every booking the API returns goes through this. */
export function withMoney<T extends MoneyBooking>(booking: T): T & MoneyFields {
  return {
    ...booking,
    paid_cents: paidCents(booking),
    total_cents: totalCentsFor(booking),
    balance_cents: balanceCentsFor(booking),
    paid_in_full: !!booking.paid_in_full,
  };
}

export function withMoneyAll<T extends MoneyBooking>(bookings: T[]): Array<T & MoneyFields> {
  return bookings.map(withMoney);
}
