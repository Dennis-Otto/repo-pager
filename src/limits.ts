/**
 * The daily limits of the free plan of Cloudflare that the pager lives within, as
 * Cloudflare documents them, and what the pager does when it uses one up all the
 * same: it tells its maintainer once that day, as far as it still can, and the
 * answer to the health check of the control repository carries the limit.
 * docs/costs.md says what each event costs, and test/costs.test.ts holds a busy
 * day of a fleet of repositories below a third of each limit.
 *
 * - Workers: 100,000 requests a day, https://developers.cloudflare.com/workers/platform/limits/
 * - Durable Objects: 100,000 requests and 13,000 GB-s a day, 100,000 rows written
 *   and 5 million read, https://developers.cloudflare.com/durable-objects/platform/pricing/
 * - Workers KV: 100,000 reads, 1,000 writes, 1,000 deletes and 1,000 lists a day,
 *   https://developers.cloudflare.com/kv/platform/pricing/
 * - Workers Logs: 200,000 log events a day, one for each invocation of the Worker
 *   or of the Durable Object and one for each line logged,
 *   https://developers.cloudflare.com/workers/observability/logs/workers-logs/
 *
 * Each resets at 00:00 UTC. Over the requests of the Worker, Cloudflare answers
 * every request with its error 1027 before the Worker runs, so the pager can't
 * tell of that one itself: the health check of the control repository sees it.
 */
import type { Context } from "./pager.ts";
import type { Phrase } from "./texts.ts";

/** The daily limits of the free plan, by what they count. */
export const LIMITS = {
  /** Requests of the Worker, each delivery of GitHub and each run of the schedule. */
  requests: 100_000,
  /** Requests of the Durable Object: each call of the Worker on it. */
  objects: 100_000,
  kvReads: 100_000,
  kvWrites: 1_000,
  kvDeletes: 1_000,
  kvLists: 1_000,
  /** Rows of the storage of the Durable Object that a day may write. */
  rowsWritten: 100_000,
  /** Events of Workers Logs, which keeps every invocation and every line logged. */
  logs: 200_000,
} as const;

/** A daily limit that the runtime refuses an operation over, as an error says it. */
export type Limit =
  | "kvReads"
  | "kvWrites"
  | "kvDeletes"
  | "kvLists"
  | "objects";

/** The text of each limit in the catalogs. */
const NAMES: Readonly<Record<Limit, Phrase>> = {
  kvReads: { key: "limit.kvReads" },
  kvWrites: { key: "limit.kvWrites" },
  kvDeletes: { key: "limit.kvDeletes" },
  kvLists: { key: "limit.kvLists" },
  objects: { key: "limit.objects" },
};

const KV: Readonly<Record<string, Limit>> = {
  get: "kvReads",
  put: "kvWrites",
  delete: "kvDeletes",
  list: "kvLists",
};

/**
 * Which daily limit an error of the runtime says was used up, or null for any
 * other error: Workers KV says such as "KV put() limit exceeded for the day.",
 * and a Durable Object that its free tier refuses names its free tier.
 */
export function limitOf(error: unknown): Limit | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const kv = /\bKV (get|put|delete|list)\(\) limit exceeded/i.exec(
    error.message,
  );
  if (kv !== null) {
    return KV[(kv[1] as string).toLowerCase()] as Limit;
  }
  return /durable objects?\b.*\b(free tier|limit)/i.test(error.message)
    ? "objects"
    : null;
}

/** The key of the last limit that the pager used up, in the storage of the Durable Object. */
export const LIMIT_HIT = "limit";

/** The last daily limit that the pager used up: which, and when, in ISO 8601. */
export interface LimitHit {
  limit: Limit;
  at: string;
}

/** The day of a moment, in UTC, on which the limits of Cloudflare count. */
function dayOf(time: number | string): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Tell the maintainer that a daily limit is used up: once a day, whichever limit
 * came first, since every event after it fails the same way until the limit
 * resets. The note in the storage of the Durable Object comes first, so that a
 * message that Telegram refuses isn't tried with each event of the day.
 */
export async function tellLimit(context: Context, limit: Limit): Promise<void> {
  const known = await context.local.get<LimitHit>(LIMIT_HIT);
  if (known !== undefined && dayOf(known.at) === dayOf(context.now())) {
    return;
  }
  await context.local.put<LimitHit>(LIMIT_HIT, {
    limit,
    at: new Date(context.now()).toISOString(),
  });
  await context.telegram.say(limitText(context.t, limit));
}

/**
 * After an error: when it says that a daily limit is used up, tell the maintainer,
 * as far as the pager still can; a failure of that goes to the log alone.
 */
export async function noteLimit(
  context: Context,
  error: unknown,
): Promise<void> {
  const limit = limitOf(error);
  if (limit === null) {
    return;
  }
  try {
    await tellLimit(context, limit);
  } catch (untold) {
    console.error(
      `The pager couldn't tell of the limit ${limit}:`,
      untold instanceof Error ? untold.name : "unknown error",
    );
  }
}

/**
 * The day on which the Worker last told of a limit that its Durable Object used up,
 * when it can't reach that object and its storage: one message per day and isolate.
 */
let toldOn: string | null = null;

/** Forget the day of the last message of the Worker, as a new isolate would. */
export function forgetTold(): void {
  toldOn = null;
}

/**
 * Whether the Worker tells of a limit now, outside the Durable Object: once per
 * day in an isolate, which is as far as it can when the object refuses it.
 */
export function tellsNow(now: number): boolean {
  const day = dayOf(now);
  if (toldOn === day) {
    return false;
  }
  toldOn = day;
  return true;
}

/** The text that tells of a limit, in the words of a catalog. */
export function limitText(t: Context["t"], limit: Limit): string {
  return t("message.limit", { limit: t.phrase(NAMES[limit]) });
}
