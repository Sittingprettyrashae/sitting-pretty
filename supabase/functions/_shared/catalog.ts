// Service catalog logic. Data lives in ./services-data.ts, a generated
// mirror of /services-data.js so client and server always agree.
// Rules below are the contract in API.md; do not change them on one side only.

import { RAW_SERVICES } from "./services-data.ts";

export interface ServiceItem {
  service_id: string;
  cat: string;
  name: string;
  price: string;
  duration_min: number;
  deposit_cents: number | null;
  note: string;
}

// API.md: service_id = slugify(cat + "--" + name)
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// "$175" -> 17500, "$50+" -> 5000, no digits -> null
export function parsePriceCents(price: string): number | null {
  const m = price.match(/\$?\s*(\d+)/);
  return m ? parseInt(m[1], 10) * 100 : null;
}

// API.md deposit rules, applied to the note (4th field):
// "$25 deposit" -> 2500; "paid in full" variants -> full price; else null.
export function parseDepositCents(note: string, price: string): number | null {
  const m = note.match(/\$(\d+)\s*deposit/i);
  if (m) return parseInt(m[1], 10) * 100;
  if (/paid in full|pay in full|full payment/i.test(note)) return parsePriceCents(price);
  return null;
}

// "2 hr 45 min" -> 165, "3 hr" -> 180, "45 min" -> 45.
// A few rows (travel fees) list no duration; they occupy one 30 min slot,
// the booking grid's minimum, so they still block a concrete time.
export function parseDurationMin(duration: string): number {
  const hr = duration.match(/(\d+)\s*hr/i);
  const min = duration.match(/(\d+)\s*min/i);
  const total = (hr ? parseInt(hr[1], 10) * 60 : 0) + (min ? parseInt(min[1], 10) : 0);
  return total > 0 ? total : 30;
}

export const CATEGORIES: Array<{ cat: string; items: ServiceItem[] }> = RAW_SERVICES.map(
  ({ cat, items }) => ({
    cat,
    items: items.map(([name, price, duration, note]) => ({
      service_id: slugify(cat + "--" + name),
      cat,
      name,
      price,
      duration_min: parseDurationMin(duration),
      deposit_cents: parseDepositCents(note, price),
      note,
    })),
  }),
);

export const SERVICES_BY_ID: Map<string, ServiceItem> = new Map(
  CATEGORIES.flatMap(({ items }) => items.map((item) => [item.service_id, item])),
);

// Payload for GET /api/services per API.md.
export function servicesPayload() {
  return {
    categories: CATEGORIES.map(({ cat, items }) => ({
      cat,
      items: items.map(({ service_id, name, price, duration_min, deposit_cents, note }) => ({
        service_id,
        name,
        price,
        duration_min,
        deposit_cents,
        note,
      })),
    })),
  };
}
