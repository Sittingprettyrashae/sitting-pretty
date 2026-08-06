// Her working week, read from and written to the public.hours table.
//
// HOURS ARE DATA, NOT CODE. This module is the only place production reads
// them, so the availability engine, her dashboard, and the hours table on the
// public site can never disagree. Contract: API.md "Hours".
//
// The values below are DEFAULTS (her real StyleSeat hours), used to seed the
// table in schema.sql and to stand in for a weekday row that has somehow gone
// missing. Changing them here changes nothing she has already set.

import { adminDb } from "./db.ts";
import { HttpError } from "./http.ts";

export interface DayHours {
  weekday: number; // 0 = Sunday .. 6 = Saturday
  closed: boolean;
  open: string | null; // "HH:MM" 24h, null when closed
  close: string | null;
}

export const DEFAULT_HOURS: readonly DayHours[] = Object.freeze([
  { weekday: 0, closed: true, open: null, close: null },
  { weekday: 1, closed: false, open: "09:00", close: "20:00" },
  { weekday: 2, closed: false, open: "09:00", close: "20:00" },
  { weekday: 3, closed: false, open: "09:00", close: "20:00" },
  { weekday: 4, closed: false, open: "09:00", close: "20:00" },
  { weekday: 5, closed: false, open: "09:00", close: "20:00" },
  { weekday: 6, closed: false, open: "09:00", close: "18:00" },
]);

// Slots step 30 minutes, so a start or end time off the half hour could never
// be offered anyway. Rejecting it up front is kinder than silently rounding.
const TIME_RE = /^([01][0-9]|2[0-3]):(00|30)$/;

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

export function minToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// Today's date + minutes since midnight in America/Chicago. Everything about
// the schedule is in salon time, no matter where the edge function runs or
// where the person tapping the button happens to be.
export function chicagoNow(): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10),
  };
}

function defaultFor(weekday: number): DayHours {
  return { ...DEFAULT_HOURS[weekday] };
}

// Rows come back exactly as API.md promises: all 7 days, weekday order.
// A missing row falls back to its default rather than failing the request:
// the public site printing "Closed" for a day she works would be worse than
// printing the hours she started with.
export async function readHours(): Promise<DayHours[]> {
  const res = await adminDb()
    .from("hours")
    .select("weekday, closed, open, close")
    .order("weekday", { ascending: true });
  if (res.error) throw new HttpError(500, "Could not load the hours");

  const byDay = new Map<number, DayHours>();
  for (const row of res.data ?? []) {
    const weekday = Number(row.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    const closed = !!row.closed;
    byDay.set(weekday, {
      weekday,
      closed,
      open: closed ? null : (row.open as string | null),
      close: closed ? null : (row.close as string | null),
    });
  }
  return [0, 1, 2, 3, 4, 5, 6].map((w) => byDay.get(w) ?? defaultFor(w));
}

export async function readDayHours(weekday: number): Promise<DayHours> {
  const all = await readHours();
  return all[weekday] ?? defaultFor(weekday);
}

// Validate the whole week before a single row is touched, so a rejected save
// never leaves her with half a schedule. Messages are plain on purpose: she
// reads them on her phone.
export function parseHoursInput(body: Record<string, unknown>): DayHours[] {
  const raw = body.days;
  if (!Array.isArray(raw) || raw.length !== 7) {
    throw new HttpError(400, "Send all seven days, Sunday through Saturday.");
  }

  const byDay = new Map<number, DayHours>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      throw new HttpError(400, "Each day needs a weekday number and whether it is closed.");
    }
    const day = entry as Record<string, unknown>;
    const weekday = Number(day.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new HttpError(400, "Each weekday must be a number from 0 (Sunday) to 6 (Saturday).");
    }
    if (byDay.has(weekday)) {
      throw new HttpError(400, `${DAY_NAMES[weekday]} is listed twice. Send each day once.`);
    }

    if (day.closed === true) {
      byDay.set(weekday, { weekday, closed: true, open: null, close: null });
      continue;
    }

    const open = typeof day.open === "string" ? day.open.trim() : "";
    const close = typeof day.close === "string" ? day.close.trim() : "";
    if (!open || !close) {
      throw new HttpError(
        400,
        `${DAY_NAMES[weekday]} needs an opening and a closing time, or mark it closed.`,
      );
    }
    if (!TIME_RE.test(open) || !TIME_RE.test(close)) {
      throw new HttpError(
        400,
        `${DAY_NAMES[weekday]} times have to land on the hour or the half hour, like 09:00 or 17:30.`,
      );
    }
    if (hhmmToMin(open) >= hhmmToMin(close)) {
      throw new HttpError(
        400,
        `${DAY_NAMES[weekday]} closes before it opens. Check those two times.`,
      );
    }
    byDay.set(weekday, { weekday, closed: false, open, close });
  }

  if (byDay.size !== 7) {
    throw new HttpError(400, "Send all seven days, Sunday through Saturday.");
  }
  const week = [0, 1, 2, 3, 4, 5, 6].map((w) => byDay.get(w)!);
  // Closing every day takes her off the market entirely: the booking page
  // would offer nothing and no client could reach her, with no error to
  // explain why. Time off is what blocking individual days is for.
  if (week.every((d) => d.closed)) {
    throw new HttpError(
      400,
      "That closes every day of the week, so nobody could book you at all. " +
        "Leave at least one day open, or block individual days on your calendar for time off.",
    );
  }
  return week;
}

export async function writeHours(days: DayHours[]): Promise<DayHours[]> {
  const res = await adminDb()
    .from("hours")
    .upsert(
      days.map((d) => ({
        weekday: d.weekday,
        closed: d.closed,
        open: d.closed ? null : d.open,
        close: d.closed ? null : d.close,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "weekday" },
    );
  if (res.error) throw new HttpError(500, "Could not save your hours. Try again");
  return await readHours();
}

// Does a booking still sit inside the hours she just saved? Used to tell her
// which appointments now fall outside, never to move or cancel one: those
// times were promised to a client. See API.md "Hours".
export function fitsWithin(
  hours: DayHours,
  time: string,
  durationMin: number,
): boolean {
  if (hours.closed || !hours.open || !hours.close) return false;
  const start = hhmmToMin(time);
  return start >= hhmmToMin(hours.open) && start + durationMin <= hhmmToMin(hours.close);
}
