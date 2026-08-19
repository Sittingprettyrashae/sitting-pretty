// Holds: the few minutes a slot is reserved while a client pays her deposit.
//
// THE DEPOSIT IS WHAT BOOKS THE SPOT. No money, no appointment (API.md, POST
// /api/bookings). A service with a published deposit does not create a booking
// when someone picks a time, it creates a hold. Nobody else can take that slot
// while the hold is alive, and the appointment only exists once the money
// clears. Walk away from checkout and the time is free again in minutes.
//
// The real guarantee is in the database: holds_overlap, bookings_overlap and
// the sp_slot_guard trigger in supabase/schema.sql. This module is the
// friendly layer the API works through.
//
// PARITY: mirrors HOLD_MINUTES / db.holds / sweepExpiredHolds in
// server/server.mjs. If you change a rule here, change it there too.

import { adminDb } from "./db.ts";
import { notifySlotOpened } from "./notify.ts";

// How long a slot stays reserved while she pays. 15 minutes is the number in
// API.md and the number the booking page tells her. HOLD_MINUTES can override
// it (RUNBOOK step 3); anything unparseable falls back to 15 rather than
// leaving a hold that never expires.
export const HOLD_MINUTES = (() => {
  const raw = Number(Deno.env.get("HOLD_MINUTES") ?? "");
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 15;
})();

export const HOLD_MS = HOLD_MINUTES * 60 * 1000;

// The hold row, and the `hold` object API.md returns from POST /api/bookings.
export interface HoldRow {
  id: string;
  client_id: string;
  service_id: string;
  service_name: string;
  price: string;
  deposit_cents: number;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM 24h
  duration_min: number;
  notes: string;
  stripe_session_id: string | null;
  created_at: string;
  expires_at: string;
}

/** When a hold started now would run out. */
export function holdExpiry(from: number = Date.now()): string {
  return new Date(from + HOLD_MS).toISOString();
}

/**
 * An abandoned checkout must never keep a Saturday locked. Called before every
 * availability and booking read, and again on a schedule (RUNBOOK step 6).
 *
 * Availability does not depend on this having run: it only ever counts holds
 * that have not run out yet, and the sp_slot_guard trigger clears the day's
 * expired holds before any new claim is checked. This keeps the table tidy and
 * is the third layer of the same promise.
 *
 * A failure here is logged, never raised: a housekeeping problem must not stop
 * someone from booking.
 */
export async function sweepExpiredHolds(): Promise<void> {
  const res = await adminDb()
    .from("holds")
    .delete()
    .lte("expires_at", new Date().toISOString())
    .select("date, time, duration_min");
  if (res.error) {
    console.error("Could not clear expired holds:", res.error.message);
    return;
  }
  // An abandoned checkout frees the window as surely as a cancellation, and
  // a taken chip can be taken ONLY because of a hold -- someone waiting on it
  // must hear when it lapses. notifySlotOpened verifies the slot is really
  // free before sending, so a hold that expires and is instantly re-taken
  // sends nothing. Never allowed to break the sweep.
  for (const h of res.data ?? []) {
    try {
      await notifySlotOpened({
        date: h.date,
        time: h.time,
        duration_min: h.duration_min,
      } as unknown as Parameters<typeof notifySlotOpened>[0]);
    } catch (err) {
      console.error("slot alert sweep failed:", err);
    }
  }
}

/**
 * The slots on this date that someone is paying for right now. Expired holds
 * are excluded by the query itself, so a dropped checkout stops blocking the
 * time the second it runs out, sweep or no sweep.
 */
export async function activeHolds(
  date: string,
): Promise<Array<{ time: string; duration_min: number }>> {
  const res = await adminDb()
    .from("holds")
    .select("time, duration_min")
    .eq("date", date)
    .gt("expires_at", new Date().toISOString());
  // Availability that silently forgot the live holds would let two people pay
  // for the same time, so this failure is loud.
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as Array<{ time: string; duration_min: number }>;
}
