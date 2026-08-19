// Her 24-hour deposit rule, actually enforced, and actually announced.
//
// Under the hold model no NEW appointment can reach `awaiting_deposit`: a
// service with a published deposit creates a hold, and the booking only exists
// once the money clears (_shared/holds.ts). Appointments made before that
// change can still be sitting there unpaid, and her rule has always been the
// same: a deposit that is not paid within 24 hours of booking cancels the
// appointment.
//
// This sweep is what does it, and it TELLS BOTH OF THEM. The client learns her
// time is gone, and Ebony learns the slot reopened, which is the row API.md
// promises her in "What Ebony is told". The pure-SQL version of this job in
// RUNBOOK step 6 could not send either message, which is why the cleanup moved
// here.
//
// PARITY: mirrors sweepExpiredDeposits in server/server.mjs.

import { adminDb } from "./db.ts";
import {
  notifyDepositExpired,
  notifyOwnerDepositExpired,
  notifySlotOpened,
} from "./notify.ts";

export const DEPOSIT_DEADLINE_MS = 24 * 60 * 60 * 1000;

export async function sweepExpiredDeposits(): Promise<void> {
  const cutoff = new Date(Date.now() - DEPOSIT_DEADLINE_MS).toISOString();

  // One statement flips the rows and hands back exactly the ones THIS call
  // changed. Two requests sweeping at the same moment cannot both claim the
  // same booking, so nobody is told twice that her appointment came off.
  //
  // canceled_by is 'admin' rather than a new value: the column's check
  // constraint has only ever allowed 'client' or 'admin', and widening it on
  // her live database to record who is really cancelling would buy nothing
  // that the notification does not already say plainly.
  const res = await adminDb()
    .from("bookings")
    .update({ status: "canceled", canceled_by: "admin" })
    .eq("status", "awaiting_deposit")
    .lt("created_at", cutoff)
    .select("*");
  if (res.error) {
    console.error("Could not cancel unpaid deposits:", res.error.message);
    return;
  }

  for (const booking of res.data ?? []) {
    await notifyDepositExpired(booking);
    await notifyOwnerDepositExpired(booking);
    // The lapsed deposit just reopened the window; tell whoever asked.
    try {
      await notifySlotOpened(booking);
    } catch (err) {
      console.error("slot alert sweep failed:", err);
    }
  }
}
