// POST /api/bookings/:id/cancel (owner or admin) -> { booking }
// Sets status canceled, records who canceled, notifies the client.

import { requireClient } from "../_shared/auth.ts";
import { adminDb } from "../_shared/db.ts";
import { HttpError, json } from "../_shared/http.ts";
import { withMoney } from "../_shared/money.ts";
import { notifyBookingCanceled } from "../_shared/notify.ts";

export async function handleCancel(req: Request, bookingId: string): Promise<Response> {
  const client = await requireClient(req);
  const db = adminDb();

  const found = await db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (found.error) throw new HttpError(500, "Could not load the booking");
  const booking = found.data;
  if (!booking) throw new HttpError(404, "Booking not found");

  const isOwner = booking.client_id === client.id;
  if (!isOwner && !client.is_admin) throw new HttpError(403, "Not your booking");

  if (booking.status === "canceled") return json({ booking: withMoney(booking) });

  const canceledBy: "client" | "admin" = isOwner ? "client" : "admin";
  const updated = await db
    .from("bookings")
    .update({ status: "canceled", canceled_by: canceledBy })
    .eq("id", bookingId)
    .select("*")
    .single();
  if (updated.error) throw new HttpError(500, "Could not cancel the booking");

  await notifyBookingCanceled(updated.data, canceledBy);
  return json({ booking: withMoney(updated.data) });
}
