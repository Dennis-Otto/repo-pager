/**
 * The one sweep of the topics that were done before this version of the pager. A
 * thing that was done before 0.11.0 never got its done mark (doneAt), so the
 * schedule never deletes its topic (clearTopics() of src/schedule.ts), and the
 * topic of a release whose next version came after it was published is known
 * only from its link: the record of the repository moved on. Telegram lists no
 * topics of a chat, and the links of done topics expire 30 days after they got
 * their ✅, so the pager goes through those links itself, once, while they last.
 *
 * Where the instance sets DONE_TOPIC_HOURS, the first run of the schedule of this
 * version notes when it ran, and the sweep starts the hours of the instance after
 * it, so that every old topic is past its hours, as a new one would be. Only a
 * link written as done before that first run counts: its time of expiry less 30
 * days is when it got its ✅. For each, the record decides. A thing that names this
 * topic, is done, has no done mark and wasn't cleared loses its topic as after a
 * press of 🗑 Delete topic (clearTopic() of src/topics.ts). A thing that is gone,
 * or names another topic or none, such as a release that moved on, loses nothing,
 * and its old topic goes without a write. Anything else stays: an open thing, one
 * with a done mark, which the schedule deletes itself, and a link without a time
 * of expiry. The sweep never touches the main view and never sends a message.
 *
 * Each run takes one page of the list and stays within the bounds below, with the
 * calls to the network that the other steps of the run left, as its last step: a
 * run holds the queue of the Durable Object, and the free plan of Workers KV allows
 * 1,000 writes and 1,000 lists a day (docs/costs.md). The storage of the Durable
 * Object keeps where it stands, so that the next run goes on after the last key it
 * handled. A refusal of Telegram ends the run; the next run tries that key again,
 * and after CLEAR_FOR it goes past it, and the topic stays. Once the list is
 * through, or 30 days after the first run, when no such link is left, the sweep
 * notes its end, and from then on costs only the look at that note.
 */
import { SUBREQUESTS } from "./deliveries.ts";
import type { Context } from "./pager.ts";
import { CLEAR_FOR } from "./schedule.ts";
import { isDone, MONTH, type TopicLink } from "./store.ts";
import { clearTopic } from "./topics.ts";

/** The key of the sweep in the storage of the Durable Object. */
export const SWEEP = "sweep";

/** The most links that one run lists, with one list of Workers KV. */
export const SWEEP_PAGE = 20;

/** The most topics that one run deletes, each one call to Telegram. */
export const SWEEP_DELETES = 10;

/** The most records that one run writes, each for a thing whose topic it deleted. */
export const SWEEP_WRITES = 3;

/**
 * How long a link of a done topic lives, in milliseconds (link() of Store): 30 days
 * after the first run, no link from before it is left.
 */
export const LINK_LIFE = MONTH * 1000;

/** Where the sweep stands, in the storage of the Durable Object. */
export interface Sweep {
  /**
   * The first run of the schedule of this version where the instance set
   * DONE_TOPIC_HOURS, in milliseconds since 1970: the sweep takes the topics that
   * were done before it.
   */
  first: number;
  /** When the sweep starts: the hours of the instance after the first run. */
  start: number;
  /** The cursor of the page that it goes through; none for the first page. */
  cursor?: string;
  /** The last key of that page that it handled; none before the first. */
  last?: string;
  /** The key that Telegram refused to delete the topic of, and since when. */
  refused?: { key: string; since: number };
  /** How many topics it deleted. */
  deleted: number;
  /** When it ended; none while it goes on. */
  ended?: number;
}

/** What is left of the bounds of one run. */
interface Left {
  deletes: number;
  writes: number;
}

/**
 * One run of the sweep, as the last step of a run of the schedule. Without
 * DONE_TOPIC_HOURS, the instance keeps every done topic, and the sweep does
 * nothing at all.
 */
export async function sweepTopics(context: Context): Promise<void> {
  const after = context.store.clearAfter;
  if (after === null) {
    return;
  }
  const now = context.now();
  const sweep = await context.local.get<Sweep>(SWEEP);
  if (sweep === undefined) {
    await context.local.put<Sweep>(SWEEP, {
      first: now,
      start: now + after,
      deleted: 0,
    });
    return;
  }
  if (
    sweep.ended !== undefined ||
    now < sweep.start ||
    context.subrequests() >= SUBREQUESTS
  ) {
    return;
  }
  try {
    if (now >= sweep.first + LINK_LIFE) {
      end(sweep, now);
      return;
    }
    const page = await context.store.topicLinks(
      sweep.cursor ?? null,
      SWEEP_PAGE,
    );
    const left: Left = { deletes: SWEEP_DELETES, writes: SWEEP_WRITES };
    for (const link of page.links) {
      // A list has no "start after": the keys up to the last one handled went.
      if (sweep.last !== undefined && link.key <= sweep.last) {
        continue;
      }
      if (!(await sweepOne(context, sweep, link, left))) {
        return;
      }
      sweep.last = link.key;
    }
    if (page.cursor === null) {
      end(sweep, now);
    } else {
      sweep.cursor = page.cursor;
      delete sweep.last;
    }
  } finally {
    await context.local.put(SWEEP, sweep);
  }
}

/** Note the end of the sweep, and say in the log what it did. */
function end(sweep: Sweep, now: number): void {
  sweep.ended = now;
  delete sweep.cursor;
  delete sweep.last;
  delete sweep.refused;
  console.info(
    `The topics done before this version are through: ${sweep.deleted} deleted`,
  );
}

/**
 * Handle one link. Returns whether the run goes on with the next one, or stops
 * here, without a write: at the bounds of the run, or at a refusal of Telegram.
 */
async function sweepOne(
  context: Context,
  sweep: Sweep,
  link: TopicLink,
  left: Left,
): Promise<boolean> {
  // Only a link written as done, before the first run of this version.
  if (link.expires === null || link.expires - LINK_LIFE >= sweep.first) {
    return true;
  }
  const id = await context.store.linked(link.thread);
  const item = id === null ? null : await context.store.get(id);
  // The thing whose topic this still is, if any.
  const own = item?.topic?.thread === link.thread ? item : null;
  if (own !== null && (!isDone(own) || own.doneAt !== undefined)) {
    // Open, or done with its mark, which the schedule deletes itself.
    return true;
  }
  if (own === null && item?.cleared === true && item.topic === null) {
    // Its thing was cleared since, which deleted this topic with it.
    return true;
  }
  if (
    left.deletes === 0 ||
    (own !== null && left.writes === 0) ||
    context.subrequests() >= SUBREQUESTS
  ) {
    return false;
  }
  left.deletes -= 1;
  const gone =
    own === null
      ? await context.telegram.removeTopic(link.thread)
      : await clearTopic(context, own);
  if (gone) {
    if (own !== null) {
      left.writes -= 1;
    }
    sweep.deleted += 1;
    delete sweep.refused;
    return true;
  }
  const now = context.now();
  if (sweep.refused?.key !== link.key) {
    sweep.refused = { key: link.key, since: now };
    return false;
  }
  if (sweep.refused.since > now - CLEAR_FOR) {
    return false;
  }
  console.warn(
    `Telegram refused to delete topic ${link.thread} for a day; it stays`,
  );
  delete sweep.refused;
  return true;
}
