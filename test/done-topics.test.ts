// The topic of a thing that is done: 🗑 Delete topic deletes it with every message of
// it at one press, and where the instance sets DONE_TOPIC_HOURS, the schedule does
// so once they are over, with its own run, while every topic that is still open
// stays. A thing whose topic went shows nothing while it stays done, and opens a
// new topic once it opens again.
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { keyboard } from "../src/buttons.ts";
import { SUBREQUESTS } from "../src/deliveries.ts";
import { DUE, type Due } from "../src/due.ts";
import { open } from "../src/open.ts";
import { apply, show } from "../src/pager.ts";
import type { Signal } from "../src/rules.ts";
import { CLEAR_FOR, MAX_CLEARS, runSchedule } from "../src/schedule.ts";
import type { Settings } from "../src/settings.ts";
import {
  type Alarm,
  type Item,
  itemId,
  keys,
  type Release,
} from "../src/store.ts";
import { Telegram } from "../src/telegram.ts";
import { texts } from "../src/texts.ts";
import { postBelow } from "../src/topics.ts";
import { handleUpdate } from "../src/updates.ts";
import {
  CHAT,
  DELETE_TOPIC,
  json,
  Net,
  REPO,
  START,
  type World,
  withTopics,
  world,
} from "./helpers.ts";

const HOUR = 60 * 60 * 1000;
const at = { repo: REPO, installation: 9 };

function failing(key: string, repo = REPO): Signal {
  return {
    ...at,
    repo,
    type: "failing",
    key,
    label: { key: "entry.bot", values: { title: `${key} fails` } },
    url: `https://github.com/${repo}/actions/runs/1`,
  };
}

function recovered(key: string, repo = REPO): Signal {
  return { ...at, repo, type: "recovered", key };
}

/** A chat with topics, on an instance with these settings. */
async function chat(overrides: Partial<Settings> = {}): Promise<World> {
  const w = await world(overrides);
  withTopics(w.net);
  return w;
}

async function alarm(w: World, repo = REPO): Promise<Alarm> {
  return (await w.context.store.get(await itemId(keys.alarm(repo)))) as Alarm;
}

/** The metadata of the record of the alarm of a repository, which the list reads. */
async function marks(repo = REPO): Promise<unknown> {
  const id = await itemId(keys.alarm(repo));
  return (await env.PAGER.list({ prefix: `item:${id}` })).keys[0]?.metadata;
}

/** The threads of the topics that the pager deleted. */
const deleted = (w: World) =>
  w.net.telegram("deleteForumTopic").map((call) => call.body.message_thread_id);

/** Press a button of the chat, as the maintainer does. */
async function press(w: World, data: string, message: number) {
  const outcome = await handleUpdate(w.context, {
    callback_query: {
      id: "q",
      from: { id: CHAT },
      data,
      message: { message_id: message },
    },
  });
  return {
    outcome,
    answer: w.net.telegram("answerCallbackQuery").at(-1)?.body,
  };
}

/** Telegram refuses deleteForumTopic as given. */
function refusing(net: Net, error_code: number, description: string): Net {
  return net.on("POST", /\/deleteForumTopic$/, () =>
    json({ ok: false, error_code, description }, error_code),
  );
}

describe("the button 🗑 Delete topic", () => {
  it("is the only button of a done thing in its topic, and none in the main view", async () => {
    const w = await chat();
    await apply(w.context, failing("check:lint"));
    const open = await alarm(w);
    expect(keyboard(open, w.context.t).flat()).not.toContainEqual(
      expect.objectContaining({ text: "🗑 Delete topic" }),
    );
    await apply(w.context, recovered("check:lint"));
    const done = await alarm(w);
    expect(done).toMatchObject({ state: "recovered", doneAt: START });
    expect(w.net.telegram("editMessageText").at(-1)?.body.reply_markup).toEqual(
      { inline_keyboard: DELETE_TOPIC },
    );
    // A done thing in the main view has no topic to delete.
    expect(keyboard({ ...done, topic: null }, w.context.t)).toEqual([]);
    // In German, too.
    expect(keyboard(done, texts("de"))).toEqual([
      [{ text: "🗑 Thema löschen", callback_data: `delete:${done.id}` }],
    ]);
  });

  it("deletes the topic with every message at one press, and forgets it", async () => {
    const w = await chat();
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    const done = await alarm(w);
    const message = done.messageId as number;
    const { outcome, answer } = await press(w, `delete:${done.id}`, message);
    expect(outcome).toBe("delete: Topic deleted.");
    // The press is answered, so that Telegram stops its spinner.
    expect(answer).toMatchObject({
      callback_query_id: "q",
      text: "Topic deleted.",
    });
    expect(deleted(w)).toEqual([900]);
    expect(w.net.telegram("deleteForumTopic")[0]?.body).toEqual({
      chat_id: CHAT,
      message_thread_id: 900,
    });
    const cleared = await alarm(w);
    expect(cleared).toMatchObject({
      state: "recovered",
      topic: null,
      messageId: null,
      cleared: true,
    });
    expect(cleared).not.toHaveProperty("doneAt");
    // Nothing waits for the schedule, and the message went with its topic: no
    // call takes its buttons off.
    expect(await marks()).toBeUndefined();
    expect(w.net.telegram("editMessageReplyMarkup")).toEqual([]);
    // A second press, from a client that still shows the message, does no harm.
    const again = await press(w, `delete:${done.id}`, message);
    expect(again.answer).toMatchObject({ show_alert: true });
    expect(deleted(w)).toEqual([900]);
  });

  it("forgets a topic that is gone already, as one that the maintainer deleted by hand", async () => {
    const w = await chat();
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    refusing(w.net, 400, "Bad Request: TOPIC_ID_INVALID");
    const done = await alarm(w);
    const { answer } = await press(w, `delete:${done.id}`, 100);
    expect(answer).toMatchObject({ text: "Topic deleted." });
    expect(await alarm(w)).toMatchObject({ topic: null, cleared: true });
  });

  it("keeps the topic when Telegram refuses, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const w = await chat();
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    refusing(w.net, 429, "Too Many Requests: retry after 30");
    const done = await alarm(w);
    const { answer } = await press(w, `delete:${done.id}`, 100);
    expect(answer).toMatchObject({
      text: "😢 Telegram didn't delete the topic. Try again later.",
      show_alert: true,
    });
    expect(await alarm(w)).toEqual(done);
    expect(warn).toHaveBeenCalledWith(
      "Telegram deleteForumTopic: Too Many Requests: retry after 30",
    );
    warn.mockRestore();
  });

  it("takes an ignored thing's topic too, beside ↩️ Bring back", async () => {
    const w = await chat();
    await apply(w.context, failing("check:lint"));
    const open = await alarm(w);
    await press(w, `ignore:${open.id}`, 100);
    const ignored = await alarm(w);
    expect(ignored.doneAt).toBe(START);
    expect(keyboard(ignored, w.context.t)).toEqual([
      [
        { text: "↩️ Bring back", callback_data: `restore:${open.id}` },
        { text: "🗑 Delete topic", callback_data: `delete:${open.id}` },
      ],
    ]);
    // Brought back, it is open again: its topic stays, and waits for nothing.
    await press(w, `restore:${open.id}`, 100);
    expect(await alarm(w)).not.toHaveProperty("doneAt");
    expect(await marks()).toBeUndefined();
  });

  it("isn't what /open lists, as a release that merged offers it", async () => {
    const w = await chat();
    const id = await itemId(keys.release(REPO));
    const merged: Release = {
      id,
      ...at,
      kind: "release",
      state: "merged",
      number: 30,
      version: "1.2.3",
      sha: "abc",
      url: `https://github.com/${REPO}/pull/30`,
      messageId: 100,
      note: null,
      snoozedUntil: null,
      topic: { thread: 900, name: "✅ 📦 demo 1.2.3" },
    };
    await w.context.store.put(merged);
    expect(keyboard(merged, w.context.t)).toEqual([
      [{ text: "🗑 Delete topic", callback_data: `delete:${id}` }],
    ]);
    expect(await open(w.context)).toBe(w.context.t("open.none"));
  });
});

describe("DONE_TOPIC_HOURS", () => {
  it("deletes the topic of a done thing with the run after its hours, in the run of the schedule", async () => {
    const w = await chat({ doneTopicHours: 24 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    // The write that makes it done marks it for the list: nothing more.
    expect(await marks()).toEqual({ done: START });
    // The schedule notes when it is due, so that the runs before cost no list.
    await runSchedule(w.context);
    expect((await w.context.local.get<Due>(DUE))?.next).toBe(START + 24 * HOUR);
    w.clock.now = START + 24 * HOUR - 15 * 60_000;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([]);
    w.clock.now = START + 24 * HOUR;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([900]);
    expect(await alarm(w)).toMatchObject({ topic: null, cleared: true });
    expect(await marks()).toBeUndefined();
    // The next run lists once more, finds nothing due, and the runs after it are idle.
    w.clock.now += 15 * 60_000;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([900]);
    expect((await w.context.local.get<Due>(DUE))?.next).toBeNull();
  });

  it("deletes with the next run at 0", async () => {
    const w = await chat({ doneTopicHours: 0 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    w.clock.now += 15 * 60_000;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([900]);
  });

  it("keeps every topic without the setting, and the schedule stays idle", async () => {
    const w = await chat();
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    expect(await marks()).toEqual({ done: START });
    await runSchedule(w.context);
    expect((await w.context.local.get<Due>(DUE))?.next).toBeNull();
    w.clock.now = START + 400 * HOUR;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([]);
    expect(await alarm(w)).toMatchObject({ topic: { thread: 900 } });
  });

  it("never deletes the topic of a thing that is open, also one that opened again in time", async () => {
    const w = await chat({ doneTopicHours: 1 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, failing("check:lint", "Dennis-Otto/other"));
    await apply(w.context, recovered("check:lint"));
    w.clock.now += 30 * 60_000;
    // It opens again before its hour: it keeps its topic, renamed without ✅.
    await apply(w.context, failing("check:test"));
    expect(await alarm(w)).not.toHaveProperty("doneAt");
    expect(await marks()).toBeUndefined();
    w.clock.now = START + 10 * HOUR;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([]);
    expect(await alarm(w)).toMatchObject({
      state: "open",
      topic: { thread: 900 },
    });
    expect(await alarm(w, "Dennis-Otto/other")).toMatchObject({
      state: "open",
      topic: { thread: 901 },
    });
  });

  it("shows nothing of a cleared thing while it stays done, and opens a new topic when it opens again", async () => {
    const w = await chat({ doneTopicHours: 0 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    w.clock.now += 15 * 60_000;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([900]);
    const calls = w.net.calls.length;
    // The same end again, as GitHub may deliver it twice, and any change while it
    // stays done, such as a note: nothing to show, and no topic comes back.
    await apply(w.context, recovered("check:lint"));
    const cleared = await alarm(w);
    expect(await show(w.context, { ...cleared, note: "late" })).toBe(false);
    expect(w.net.calls).toHaveLength(calls);
    expect(await alarm(w)).toMatchObject({ note: "late", cleared: true });
    // It opens again: a new topic, which notifies, and the thing keeps it.
    await apply(w.context, failing("check:lint"));
    expect(w.net.telegram("createForumTopic")).toHaveLength(2);
    const reopened = await alarm(w);
    expect(reopened).toMatchObject({ state: "open", topic: { thread: 901 } });
    expect(reopened).not.toHaveProperty("cleared");
    expect(w.net.telegram("sendMessage").at(-1)?.body).toMatchObject({
      message_thread_id: 901,
    });
  });

  it("opens a new topic for a cleared thing that opens again, as any change shows it", async () => {
    const w = await chat({ doneTopicHours: 0 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    const done = await alarm(w);
    await press(w, `delete:${done.id}`, done.messageId as number);
    const cleared = await alarm(w);
    expect(await show(w.context, { ...cleared, state: "open" })).toBe(true);
    const reopened = await alarm(w);
    expect(reopened).toMatchObject({ state: "open", topic: { thread: 901 } });
    expect(reopened).not.toHaveProperty("cleared");
    expect(reopened).not.toHaveProperty("doneAt");
  });

  it("gives a done thing that opens a new topic, such as for a message below it, its hours from then", async () => {
    const w = await chat({ doneTopicHours: 1 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    const done = await alarm(w);
    await press(w, `delete:${done.id}`, done.messageId as number);
    w.clock.now += 2 * HOUR;
    const cleared = await alarm(w);
    await postBelow(w.context, cleared, "A late answer.");
    expect(cleared).toMatchObject({
      topic: { thread: 901 },
      doneAt: START + 2 * HOUR,
    });
    expect(cleared).not.toHaveProperty("cleared");
    expect(await marks()).toEqual({ done: START + 2 * HOUR });
  });

  it("tries a topic that Telegram refuses to delete again, for a day, then keeps it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const w = await chat({ doneTopicHours: 0 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    refusing(w.net, 500, "Internal Server Error");
    w.clock.now += 15 * 60_000;
    await runSchedule(w.context);
    w.clock.now += 15 * 60_000;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([900, 900]);
    expect(await marks()).toEqual({ done: START });
    w.clock.now = START + CLEAR_FOR;
    await runSchedule(w.context);
    expect(warn).toHaveBeenCalledWith(
      "Telegram refused to delete topic 900 for a day; it stays",
    );
    const kept = await alarm(w);
    expect(kept).toMatchObject({ topic: { thread: 900 } });
    expect(kept).not.toHaveProperty("doneAt");
    expect(await marks()).toBeUndefined();
    const tries = deleted(w).length;
    w.clock.now += 15 * 60_000;
    await runSchedule(w.context);
    expect(deleted(w)).toHaveLength(tries);
    warn.mockRestore();
  });

  it("deletes at most MAX_CLEARS topics per run, and the rest with the next", async () => {
    const w = await chat({ doneTopicHours: 0 });
    const repos = Array.from(
      { length: MAX_CLEARS + 2 },
      (_, index) => `Dennis-Otto/repo-${index}`,
    );
    for (const repo of repos) {
      await apply(w.context, failing("check:lint", repo));
      await apply(w.context, recovered("check:lint", repo));
    }
    // Each run of the schedule counts its own calls.
    w.context.subrequests = () => 0;
    w.clock.now += 15 * 60_000;
    await runSchedule(w.context);
    expect(deleted(w)).toHaveLength(MAX_CLEARS);
    w.clock.now += 15 * 60_000;
    await runSchedule(w.context);
    expect(deleted(w)).toHaveLength(MAX_CLEARS + 2);
  });

  it("leaves the rest for the next run when the run has no calls left", async () => {
    const w = await chat({ doneTopicHours: 0 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    w.clock.now += 15 * 60_000;
    w.context.subrequests = () => SUBREQUESTS;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([]);
    w.context.subrequests = () => 0;
    w.clock.now += 15 * 60_000;
    await runSchedule(w.context);
    expect(deleted(w)).toEqual([900]);
  });

  it("leaves a thing alone that the list names but that is no longer due", async () => {
    const w = await chat({ doneTopicHours: 1 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    const done = await alarm(w);
    // A list that lags behind a write: the record is open again, or done anew.
    const stale: Item[] = [
      { ...done, state: "open" },
      { ...done, doneAt: START + 2 * HOUR },
    ];
    w.clock.now = START + HOUR;
    for (const item of stale) {
      await w.context.store.put(done);
      const get = w.context.store.get.bind(w.context.store);
      w.context.store.get = async (id) => ((await get(id)) ? item : null);
      await runSchedule(w.context);
      w.context.store.get = get;
    }
    expect(deleted(w)).toEqual([]);
  });

  it("drops a done mark that no longer holds, without a topic or no longer done, and keeps the message", async () => {
    const w = await chat({ doneTopicHours: 1 });
    await apply(w.context, failing("check:lint"));
    await apply(w.context, recovered("check:lint"));
    const done = await alarm(w);
    w.clock.now = START + 2 * HOUR;
    for (const item of [
      { ...done, topic: null },
      { ...done, state: "open" },
    ] as Item[]) {
      await w.context.store.put(item);
      expect(await marks()).toHaveProperty("done");
      await runSchedule(w.context);
      expect(await marks()).toBeUndefined();
      const after = await alarm(w);
      expect(after).not.toHaveProperty("doneAt");
      expect(after).not.toHaveProperty("cleared");
      expect(after.messageId).toBe(done.messageId);
    }
    expect(deleted(w)).toEqual([]);
  });
});

describe("removeTopic", () => {
  const net = new Net();
  const telegram = new Telegram("123:test", CHAT, net.fetch, async () => {});

  it("says whether the topic is gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await telegram.removeTopic(900)).toBe(true);
    for (const gone of [
      "Bad Request: TOPIC_ID_INVALID",
      "Bad Request: message thread not found",
      "Bad Request: TOPIC_DELETED",
    ]) {
      refusing(net, 400, gone);
      expect(await telegram.removeTopic(900)).toBe(true);
    }
    refusing(net, 403, "Forbidden: not enough rights to delete the topic");
    expect(await telegram.removeTopic(900)).toBe(false);
    warn.mockRestore();
  });

  it("lets an error of the network go", async () => {
    const broken = new Telegram("123:test", CHAT, async () => {
      throw new TypeError("Network connection lost.");
    });
    await expect(broken.removeTopic(900)).rejects.toThrow(TypeError);
  });
});
