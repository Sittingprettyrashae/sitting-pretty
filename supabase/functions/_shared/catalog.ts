// Service catalog logic. THE MENU LIVES IN THE DATABASE now (public.services),
// edited from her dashboard's Menu tab; ./services-data.ts (a generated mirror
// of /services-data.js) is only the seed and the fallback for a project whose
// table has not been seeded yet. Slug and parsing rules are the contract in
// API.md; do not change them on one side only.

import { adminDb } from "./db.ts";
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

export interface ServiceRow extends ServiceItem {
  active: boolean;
  cat_order: number;
  sort_order: number;
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

// The seed/fallback catalog, derived from the static file exactly as before.
export const SEED_CATEGORIES: Array<{ cat: string; items: ServiceItem[] }> = RAW_SERVICES.map(
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

// The seed as flat rows, used once to populate the table (see seedServices).
export function seedRows(): ServiceRow[] {
  return SEED_CATEGORIES.flatMap(({ cat, items }, catIdx) =>
    items.map((item, i) => ({
      ...item,
      cat,
      active: true,
      cat_order: catIdx,
      sort_order: i,
    }))
  );
}

// ---------------------------------------------------------------------------
// Live catalog reads. Every caller gets the database's view of her menu; the
// static seed only answers when the table is empty (project not yet seeded)
// or unreachable, so a database hiccup degrades to yesterday's menu instead
// of an empty booking page.
// ---------------------------------------------------------------------------

function groupRows(rows: ServiceRow[]): Array<{ cat: string; items: ServiceItem[] }> {
  const cats: Array<{ cat: string; items: ServiceItem[] }> = [];
  const byCat = new Map<string, ServiceItem[]>();
  for (const r of rows) {
    if (!byCat.has(r.cat)) {
      byCat.set(r.cat, []);
      cats.push({ cat: r.cat, items: byCat.get(r.cat)! });
    }
    byCat.get(r.cat)!.push({
      service_id: r.service_id,
      cat: r.cat,
      name: r.name,
      price: r.price,
      duration_min: r.duration_min,
      deposit_cents: r.deposit_cents,
      note: r.note,
    });
  }
  return cats;
}

async function readRows(activeOnly: boolean): Promise<ServiceRow[] | null> {
  let q = adminDb()
    .from("services")
    .select("service_id, cat, name, price, duration_min, deposit_cents, note, active, cat_order, sort_order")
    .order("cat_order", { ascending: true })
    .order("sort_order", { ascending: true });
  if (activeOnly) q = q.eq("active", true);
  const res = await q;
  if (res.error) {
    console.error("services read failed, using seed:", res.error.message);
    return null;
  }
  const rows = (res.data ?? []) as ServiceRow[];
  return rows.length ? rows : null;
}

// The live menu grouped for GET /api/services.
export async function loadCategories(): Promise<Array<{ cat: string; items: ServiceItem[] }>> {
  const rows = await readRows(true);
  return rows ? groupRows(rows) : SEED_CATEGORIES;
}

// One service by its stable slug (active only: a hidden style cannot be
// booked, exactly like one that never existed).
export async function getService(serviceId: string): Promise<ServiceItem | null> {
  const res = await adminDb()
    .from("services")
    .select("service_id, cat, name, price, duration_min, deposit_cents, note")
    .eq("service_id", serviceId)
    .eq("active", true)
    .maybeSingle();
  if (res.error) {
    console.error("service lookup failed, using seed:", res.error.message);
  } else if (res.data) {
    return res.data as ServiceItem;
  } else {
    // No row. If the table is seeded this slug genuinely does not exist (or
    // is hidden); only an UNSEEDED table falls back to the static file.
    const any = await adminDb().from("services").select("service_id").limit(1);
    if (!any.error && (any.data ?? []).length > 0) return null;
  }
  for (const g of SEED_CATEGORIES) {
    for (const item of g.items) if (item.service_id === serviceId) return item;
  }
  return null;
}

// Every row including hidden ones, for the dashboard's Menu tab.
export async function loadAllRows(): Promise<ServiceRow[]> {
  const res = await adminDb()
    .from("services")
    .select("service_id, cat, name, price, duration_min, deposit_cents, note, active, cat_order, sort_order")
    .order("cat_order", { ascending: true })
    .order("sort_order", { ascending: true });
  if (res.error) throw new Error("Could not load the menu: " + res.error.message);
  const rows = (res.data ?? []) as ServiceRow[];
  return rows.length ? rows : seedRows();
}

// Payload for GET /api/services per API.md.
export async function servicesPayload() {
  const categories = await loadCategories();
  return {
    categories: categories.map(({ cat, items }) => ({
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
