/**
 * When the schedule next has something to do, as a note in the storage of the
 * Durable Object, so that a run of the schedule while nothing is due costs no
 * list and no read of Workers KV: the free plan of KV takes 1,000 lists a day, and
 * the schedule runs 96 times a day (docs/costs.md).
 *
 * The store lowers the note with each record that waits for a time, such as a
 * thing put aside with "Later" or a text that waits for its answer, and the run
 * that lists the records sets it anew from what it found. A list of Workers KV may
 * lag a minute behind a write, so a run that lists right after one keeps what the
 * write noted. A run lists all the same once SAFETY is over since its last list,
 * and whenever the note is missing, such as on the first run of a new version.
 */
import type { Local } from "./context.ts";

/** The key of the note in the storage of the Durable Object. */
export const DUE = "due";

/** How long a list of Workers KV may lag behind a write, in milliseconds. */
export const LAG = 2 * 60 * 1000;

/** The longest time between two lists of the schedule, in milliseconds. */
export const SAFETY = 6 * 60 * 60 * 1000;

export interface Due {
  /** The earliest moment at which a record waits for the schedule, or null for none. */
  next: number | null;
  /** When the store last wrote a record that waits for a time. */
  marked: number;
  /** When the schedule last listed the records. */
  listed: number;
}

/** The earlier of two moments, either of which may be none. */
export function earlier(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  return b === null ? a : Math.min(a, b);
}

/**
 * Note that a record waits for the schedule no later than at, written now. Without
 * a note, the next run lists anyway.
 */
export async function noteSoon(
  local: Local,
  at: number,
  now: number,
): Promise<void> {
  const due = await local.get<Due>(DUE);
  if (due === undefined) {
    return;
  }
  await local.put<Due>(DUE, {
    ...due,
    next: earlier(due.next, at),
    marked: now,
  });
}

/** Whether a run at now has nothing to list: nothing due, and a list since SAFETY. */
export async function idle(local: Local, now: number): Promise<boolean> {
  const due = await local.get<Due>(DUE);
  return (
    due !== undefined &&
    (due.next === null || due.next > now) &&
    due.listed > now - SAFETY
  );
}

/**
 * Note what a run that listed at listed found to be next, together with what the
 * store noted since a moment before that list, which the list may have missed.
 */
export async function noteListed(
  local: Local,
  listed: number,
  next: number | null,
): Promise<void> {
  const due = await local.get<Due>(DUE);
  const recent = due !== undefined && due.marked >= listed - LAG;
  await local.put<Due>(DUE, {
    next: recent ? earlier(next, due.next) : next,
    marked: due?.marked ?? 0,
    listed,
  });
}
