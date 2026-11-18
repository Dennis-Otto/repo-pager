// A notice below the message of a thing, such as that of a new entry of an alarm or
// of a new comment, answers that message and carries ⬇️ Show, which sends it anew
// at the end of its topic; a fresh message of a thing takes the buttons off its old
// one, also when Telegram deletes no message older than 48 hours; and a topic that
// a thing left for a new one is renamed ↪️ Moved and never deleted.
import { describe, expect, it, vi } from "vitest";

import { press } from "../src/actions.ts";
import { keyboard } from "../src/buttons.ts";
import { ALARM_CHANGE, SHOW_AGAIN } from "../src/deliveries.ts";
import { apply, QUIET, show } from "../src/pager.ts";
import { render } from "../src/render.ts";
import type { Signal } from "../src/rules.ts";
import { runSchedule } from "../src/schedule.ts";
import {
  type Alarm,
  type Contribution,
  type Item,
  itemId,
  keys,
} from "../src/store.ts";
import { texts } from "../src/texts.ts";
import { postBelow } from "../src/topics.ts";
import { handleUpdate } from "../src/updates.ts";
import {
  CHAT,
  REPO,
  refused,
  START,
  type World,
  withControl,
  withDeletedTopic,
  withLostThread,
  withTopics,
  world,
} from "./helpers.ts";

const at = { repo: REPO, installation: 9 };
const ISSUE = "https://github.com/Dennis-Otto/demo/issues/12";
const PULL = "https://github.com/Dennis-Otto/demo/pull/12";
const HOUR = 3_600_000;
/** What Telegram answers to the delete of a message older than 48 hours. */
const TOO_OLD = "Bad Request: message can't be deleted for everyone";

function failing(key: string): Signal {
  return {
    ...at,
    type: "failing",
    key,
    label: { key: "entry.bot", values: { title: `${key} fails` } },
    url: `https://github.com/${REPO}/actions/runs/1`,
  };
}

function alertOpen(key: string): Signal {
  return {
    ...at,
    type: "alert-open",
    key,
    label: { key: "entry.alert", values: { severity: "high", what: key } },
    url: "https://github.com/a",
  };
}

const issue: Signal = {
  ...at,
  type: "contribution",
  number: 12,
  pull: false,
  title: "It breaks",
  url: ISSUE,
  author: "octocat",
};

const pull: Signal = { ...issue, pull: true, title: "Fix it", url: PULL };

function remark(
  comment: number,
  kind?: "review",
): Extract<Signal, { type: "comment" }> {
  return {
    ...at,
    type: "comment",
    number: 12,
    pull: true,
    title: "Fix it",
    url: `${PULL}#${kind ?? "issuecomment"}-${comment}`,
    author: "hubot",
    comment,
    ...(kind === undefined ? {} : { kind }),
  };
}

function did(
  what: "commits" | "reopened" | "ready",
): Extract<Signal, { type: "activity" }> {
  return {
    ...at,
    type: "activity",
    number: 12,
    pull: true,
    title: "Fix it",
    url: PULL,
    author: "octocat",
    by: "octocat",
    what,
    changed: `2026-11-12T0${["commits", "reopened", "ready"].indexOf(what)}:00:00Z`,
  };
}

/** A world whose chat has topics, and whose control repository takes the drafts. */
async function chat(language: "en" | "de" = "en"): Promise<World> {
  const w = await world({ language });
  withTopics(w.net);
  withControl(w.net).on(
    "POST",
    "/repos/Dennis-Otto/control/dispatches",
    () => new Response(null, { status: 204 }),
  );
  return w;
}

async function alarmOf(w: World): Promise<Alarm> {
  return (await w.context.store.get(await itemId(keys.alarm(REPO)))) as Alarm;
}

/** A world with an open alarm in its topic 900, as message 100. */
async function alarmed(language: "en" | "de" = "en"): Promise<World> {
  const w = await chat(language);
  expect(await apply(w.context, failing("check:lint"))).toBe("alarm opened");
  return w;
}

/** The bodies of the messages that the pager sent. */
// biome-ignore lint/suspicious/noExplicitAny: the recorded JSON of a call.
const sent = (w: World): any[] =>
  w.net.telegram("sendMessage").map((call) => call.body);

/** The ids of the messages of a method, such as the deleted ones. */
const ids = (w: World, method: string) =>
  w.net.telegram(method).map((call) => call.body.message_id);

/** The button of a notice of the thing with this id, in a language. */
const showButton = (id: string, language: "en" | "de" = "en") => [
  [{ text: texts(language)("button.show"), callback_data: `show:${id}` }],
];

/** Press a button of the message shownIn, as Telegram sends the press. */
async function pressing(w: World, data: string, shownIn: number) {
  const outcome = await handleUpdate(w.context, {
    callback_query: {
      id: "q1",
      from: { id: CHAT },
      data,
      message: { message_id: shownIn },
    },
  });
  const answer = w.net.telegram("answerCallbackQuery").at(-1)?.body;
  return { outcome, answer };
}

describe("a notice below the message of a thing", () => {
  it("answers that message in its topic and carries ⬇️ Show, in each language", async () => {
    for (const language of ["en", "de"] as const) {
      const w = await alarmed(language);
      w.clock.now = START + QUIET;
      expect(await apply(w.context, failing("workflow:release"))).toBe(
        "new entry in the alarm",
      );
      const notice = sent(w).at(-1);
      expect(notice).toMatchObject({
        message_thread_id: 900,
        reply_parameters: {
          message_id: 100,
          allow_sending_without_reply: true,
        },
        reply_markup: {
          inline_keyboard: showButton((await alarmOf(w)).id, language),
        },
      });
      // It notifies, as the edit of the alarm doesn't.
      expect(notice).not.toHaveProperty("disable_notification");
    }
    expect(texts("en")("button.show")).toBe("⬇️ Show");
    expect(texts("de")("button.show")).toBe("⬇️ Zeigen");
  });

  it("of the security message, a review and each activity answers the same way", async () => {
    const w = await chat();
    await apply(w.context, alertOpen("alert:1"));
    w.clock.now = START + QUIET;
    expect(await apply(w.context, alertOpen("alert:2"))).toBe(
      "new entry in the alert",
    );
    const alert = await w.context.store.get(await itemId(keys.alert(REPO)));
    expect(sent(w).at(-1)).toMatchObject({
      text: expect.stringContaining("🛡"),
      message_thread_id: 900,
      reply_parameters: { message_id: 100, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: showButton(alert?.id ?? "") },
    });

    await apply(w.context, pull);
    const id = await itemId(keys.contribution(REPO, 12));
    const signals: Signal[] = [
      remark(5, "review"),
      did("commits"),
      did("reopened"),
      did("ready"),
    ];
    for (const [index, signal] of signals.entries()) {
      w.clock.now = START + QUIET * (index + 2);
      expect(await apply(w.context, signal)).toMatch(/shown in place$/);
      expect(sent(w).at(-1)).toMatchObject({
        message_thread_id: 901,
        reply_parameters: {
          message_id: 102,
          allow_sending_without_reply: true,
        },
        reply_markup: { inline_keyboard: showButton(id) },
      });
    }
  });

  it("answers in the main view, as before, in a chat without topics, and carries the button", async () => {
    const w = await world();
    await apply(w.context, failing("check:lint"));
    w.clock.now = START + QUIET;
    await apply(w.context, failing("workflow:release"));
    const notice = sent(w).at(-1);
    expect(notice).not.toHaveProperty("message_thread_id");
    expect(notice).toMatchObject({
      reply_parameters: { message_id: 100, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: showButton((await alarmOf(w)).id) },
    });
  });

  it("leaves the pictures of a release and a proposal as they were: no reply in a thread, and their own keyboard", async () => {
    const w = await alarmed();
    const alarm = await alarmOf(w);
    await postBelow(w.context, alarm, "The pictures");
    const proposal = [
      [{ text: "✅ Confirm", callback_data: `fix:${alarm.id}` }],
    ];
    await postBelow(w.context, alarm, "A proposal", proposal);
    const [pictures, proposed] = sent(w).slice(-2);
    expect(pictures).toMatchObject({
      message_thread_id: 900,
      reply_markup: { inline_keyboard: [] },
    });
    expect(proposed).toMatchObject({
      message_thread_id: 900,
      reply_markup: { inline_keyboard: proposal },
    });
    expect(pictures).not.toHaveProperty("reply_parameters");
    expect(proposed).not.toHaveProperty("reply_parameters");
  });

  it("never shows ⬇️ Show on the thing's own message", async () => {
    const w = await alarmed();
    w.clock.now = START + QUIET;
    await apply(w.context, failing("workflow:release"));
    const own = [
      sent(w)[0],
      ...w.net.telegram("editMessageText").map((call) => call.body),
    ];
    for (const body of own) {
      expect(JSON.stringify(body.reply_markup)).not.toContain("show:");
    }
  });
});

describe("⬇️ Show", () => {
  /** An alarm in topic 900 as message 100, with the notice 101 of a new entry. */
  async function noticed(): Promise<World> {
    const w = await alarmed();
    w.clock.now = START + QUIET;
    await apply(w.context, failing("workflow:release"));
    expect(w.net.lastMessageId).toBe(101);
    return w;
  }

  it("sends the thing's message anew at the end of its topic, quietly, and takes the old one and the button of the notice away", async () => {
    // The maintainer deleted the messages on his side only: the bot still has them.
    const w = await noticed();
    const before = await alarmOf(w);
    const put = vi.spyOn(w.context.store, "put");
    const { outcome, answer } = await pressing(w, `show:${before.id}`, 101);
    expect(outcome).toBe("show: ⬇️ Sent anew.");
    expect(answer).toMatchObject({ text: "⬇️ Sent anew.", show_alert: false });
    const message = sent(w).at(-1);
    expect(message).toMatchObject({
      message_thread_id: 900,
      disable_notification: true,
      text: render(before, w.context.now(), w.context.t),
      reply_markup: { inline_keyboard: keyboard(before, w.context.t) },
    });
    expect(message).not.toHaveProperty("reply_parameters");
    expect(
      message.reply_markup.inline_keyboard
        .flat()
        .map((button: { text: string }) => button.text),
    ).toEqual(["🛠 Start fix", "⏰ Later", "✖ Ignore"]);
    expect(ids(w, "deleteMessage")).toEqual([100]);
    expect(ids(w, "editMessageReplyMarkup")).toEqual([101]);
    // One write, of the new message; the state stays.
    expect(put).toHaveBeenCalledTimes(1);
    expect(await alarmOf(w)).toEqual({ ...before, messageId: 102 });
  });

  it("takes the buttons off the old message by an edit when Telegram deletes it no more", async () => {
    const w = await noticed();
    w.net.on("POST", /\/deleteMessage$/, () => refused(TOO_OLD));
    const alarm = await alarmOf(w);
    await pressing(w, `show:${alarm.id}`, 101);
    expect(w.net.telegram("editMessageText").at(-1)?.body).toMatchObject({
      message_id: 100,
      text: render(alarm, w.context.now(), w.context.t),
      reply_markup: { inline_keyboard: [] },
    });
    expect((await alarmOf(w)).messageId).toBe(102);
  });

  it("keeps the Later of a thing put aside, which still comes back", async () => {
    const w = await noticed();
    const alarm = await alarmOf(w);
    await press(w.context, alarm, {
      action: "later",
      id: alarm.id,
      version: null,
    });
    const snoozed = (await alarmOf(w)).snoozedUntil;
    expect(snoozed).toBe(START + QUIET + 4 * HOUR);
    await pressing(w, `show:${alarm.id}`, 101);
    expect(await alarmOf(w)).toMatchObject({ snoozedUntil: snoozed });
    expect(sent(w).at(-1)?.text).toContain("⏰");
    w.clock.now = snoozed as number;
    expect(await runSchedule(w.context)).toEqual([alarm.id]);
  });

  it("is refused on a done or an ignored thing, and loses its button there, sending and writing nothing", async () => {
    for (const state of ["recovered", "ignored"] as const) {
      const w = await noticed();
      await w.context.store.put({ ...(await alarmOf(w)), state });
      const messages = sent(w).length;
      const put = vi.spyOn(w.context.store, "put");
      const { answer } = await pressing(
        w,
        `show:${(await alarmOf(w)).id}`,
        101,
      );
      expect(answer).toMatchObject({
        text: "This button is out of date.",
        show_alert: true,
      });
      expect(sent(w)).toHaveLength(messages);
      expect(put).not.toHaveBeenCalled();
      expect(ids(w, "editMessageReplyMarkup")).toEqual([101]);
    }
  });

  it("is refused on a thing whose topic went with 🗑 Delete topic, whose notice went with it", async () => {
    const w = await noticed();
    await w.context.store.put({
      ...(await alarmOf(w)),
      state: "recovered",
      topic: null,
      messageId: null,
      cleared: true,
    });
    const { answer } = await pressing(w, `show:${(await alarmOf(w)).id}`, 101);
    expect(answer?.text).toBe("This button is out of date.");
    expect(w.net.telegram("editMessageReplyMarkup")).toHaveLength(0);
  });

  it("says that a thing gone from the store is gone, and takes the button off", async () => {
    const w = await noticed();
    const { answer } = await pressing(w, "show:i0123456789abcde", 101);
    expect(answer?.text).toBe(texts("en")("answer.gone"));
    expect(ids(w, "editMessageReplyMarkup")).toEqual([101]);
  });

  it("opens the topic of a thing that waits in the main view, and goes to the end of the main view without topics", async () => {
    const waiting = await chat();
    await waiting.context.store.put({
      ...(await (async () => {
        await apply(waiting.context, issue);
        return (await waiting.context.store.get(
          await itemId(keys.contribution(REPO, 12)),
        )) as Contribution;
      })()),
      topic: null,
    });
    const item = (await waiting.context.store.get(
      await itemId(keys.contribution(REPO, 12)),
    )) as Item;
    await pressing(waiting, `show:${item.id}`, 7);
    expect(sent(waiting).at(-1)?.message_thread_id).toBe(901);
    expect(ids(waiting, "deleteMessage")).toEqual([100]);
    expect(await waiting.context.store.get(item.id)).toMatchObject({
      messageId: 101,
      topic: { thread: 901 },
    });

    const plain = await world();
    await apply(plain.context, issue);
    const thing = (await plain.context.store.get(
      await itemId(keys.contribution(REPO, 12)),
    )) as Item;
    await pressing(plain, `show:${thing.id}`, 7);
    expect(sent(plain).at(-1)).not.toHaveProperty("message_thread_id");
    expect(ids(plain, "deleteMessage")).toEqual([100]);
  });
});

describe("a fresh message of a thing", () => {
  it("takes the buttons off the old one when Telegram deletes it no more, as ⏰ Later brings it back", async () => {
    const w = await alarmed();
    const alarm = await alarmOf(w);
    await press(w.context, alarm, {
      action: "later",
      id: alarm.id,
      version: null,
    });
    w.net.on("POST", /\/deleteMessage$/, () => refused(TOO_OLD));
    w.clock.now = START + 4 * HOUR;
    expect(await runSchedule(w.context)).toEqual([alarm.id]);
    const after = await alarmOf(w);
    expect(after.messageId).toBe(101);
    expect(w.net.telegram("editMessageText").at(-1)?.body).toMatchObject({
      message_id: 100,
      text: render(after, w.context.now(), w.context.t),
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("lets a failure of that edit, other than Telegram's, go to the caller after the new message is kept", async () => {
    const w = await alarmed();
    w.net
      .on("POST", /\/deleteMessage$/, () => refused(TOO_OLD))
      .on("POST", /\/editMessageText$/, () => {
        throw new TypeError("network");
      });
    const alarm = await alarmOf(w);
    await expect(show(w.context, alarm, true)).rejects.toThrow("network");
    expect((await alarmOf(w)).messageId).toBe(101);
  });
});

describe("a topic that Telegram doesn't find while it is there", () => {
  it("is renamed ↪️ Moved, never deleted, when ⏰ Later brings the thing back into a new topic", async () => {
    const w = await alarmed("de");
    const alarm = await alarmOf(w);
    await press(w.context, alarm, {
      action: "later",
      id: alarm.id,
      version: null,
    });
    withLostThread(w.net, 900);
    // A name stored with ✅, as a thing done in its old topic has: the new name
    // takes the thing's name without it.
    const pressed = await alarmOf(w);
    await w.context.store.put({
      ...pressed,
      topic: { thread: 900, name: "✅ 🚨 demo braucht dich" },
    });
    w.clock.now = START + 4 * HOUR;
    expect(await runSchedule(w.context)).toEqual([alarm.id]);
    expect(await alarmOf(w)).toMatchObject({
      messageId: 101,
      topic: { thread: 901, name: "🚨 demo braucht dich" },
    });
    expect(sent(w).at(-1)?.message_thread_id).toBe(901);
    expect(ids(w, "deleteMessage")).toEqual([100]);
    expect(w.net.telegram("editForumTopic").map((call) => call.body)).toEqual([
      expect.objectContaining({
        message_thread_id: 900,
        name: "↪️ Umgezogen: 🚨 demo braucht dich",
      }),
    ]);
    expect(w.net.telegram("deleteForumTopic")).toHaveLength(0);
  });

  it("takes the old message out of it as a new entry opens a new topic, and the notice answers the new one there", async () => {
    for (const tooOld of [false, true]) {
      const w = await alarmed();
      withLostThread(w.net, 900);
      if (tooOld) {
        w.net.on("POST", /\/deleteMessage$/, () => refused(TOO_OLD));
      }
      w.clock.now = START + QUIET;
      expect(await apply(w.context, failing("workflow:release"))).toBe(
        "new entry in the alarm",
      );
      const alarm = await alarmOf(w);
      expect(alarm).toMatchObject({ messageId: 101, topic: { thread: 901 } });
      const [own, notice] = sent(w).slice(-2);
      expect(own).toMatchObject({
        message_thread_id: 901,
        reply_markup: { inline_keyboard: keyboard(alarm, w.context.t) },
      });
      expect(notice).toMatchObject({
        message_thread_id: 901,
        reply_parameters: {
          message_id: 101,
          allow_sending_without_reply: true,
        },
        reply_markup: { inline_keyboard: showButton(alarm.id) },
      });
      expect(ids(w, "deleteMessage")).toEqual([100]);
      // The edit in place, and without a delete the one that takes its buttons off.
      const edits = w.net.telegram("editMessageText").map((call) => call.body);
      expect(edits.map((body) => body.message_id)).toEqual(
        tooOld ? [100, 100] : [100],
      );
      if (tooOld) {
        expect(edits[1]?.reply_markup).toEqual({ inline_keyboard: [] });
      }
      expect(w.net.telegram("editForumTopic")[0]?.body).toMatchObject({
        message_thread_id: 900,
        name: "↪️ Moved: 🚨 demo needs you",
      });
      expect(w.net.telegram("deleteForumTopic")).toHaveLength(0);
      // A press of ⬇️ Show on a notice left in the old topic goes to the new one.
      await pressing(w, `show:${alarm.id}`, 99);
      expect(sent(w).at(-1)?.message_thread_id).toBe(901);
    }
  });

  it("keeps its name when Telegram refuses the rename or fails, and the thing goes on in its new topic", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const answer of [
      () => refused("Bad Request: not enough rights"),
      () => {
        throw new TypeError("network");
      },
    ]) {
      const w = await alarmed();
      withLostThread(w.net, 900).on("POST", /\/editForumTopic$/, answer);
      w.clock.now = START + QUIET;
      expect(await apply(w.context, failing("workflow:release"))).toBe(
        "new entry in the alarm",
      );
      expect(await alarmOf(w)).toMatchObject({ topic: { thread: 901 } });
      expect(sent(w).at(-1)?.message_thread_id).toBe(901);
    }
    expect(warn).toHaveBeenCalledWith(
      "Telegram editForumTopic: Bad Request: not enough rights",
    );
    expect(warn).toHaveBeenCalledWith(
      "Telegram renames no topic that a thing left: TypeError",
    );
  });
});

describe("a topic that is really gone", () => {
  it("is passed over by the rename without a warning, and its old message counts as deleted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await alarmed();
    withDeletedTopic(w.net, 900).on("POST", /\/deleteMessage$/, (call) =>
      call.body.message_id === 100
        ? refused("Bad Request: message to delete not found")
        : undefined,
    );
    w.clock.now = START + QUIET;
    expect(await apply(w.context, failing("workflow:release"))).toBe(
      "new entry in the alarm",
    );
    expect(await alarmOf(w)).toMatchObject({
      messageId: 101,
      topic: { thread: 901 },
    });
    // The thing's own message opens the new topic, and the notice answers it there.
    const alarm = await alarmOf(w);
    const [own, notice] = sent(w).slice(-2);
    expect(own).toMatchObject({
      message_thread_id: 901,
      reply_markup: { inline_keyboard: keyboard(alarm, w.context.t) },
    });
    expect(notice).toMatchObject({
      message_thread_id: 901,
      reply_parameters: { message_id: 101, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: showButton(alarm.id) },
    });
    expect(ids(w, "deleteMessage")).toEqual([100]);
    // Only the edit in place: the delete counted as done.
    expect(ids(w, "editMessageText")).toEqual([100]);
    expect(w.net.telegram("editForumTopic")).toHaveLength(1);
    expect(
      warn.mock.calls
        .flat()
        .some((line) => String(line).includes("editForumTopic")),
    ).toBe(false);
  });
});

/** How many calls the pager made to Telegram so far. */
const telegramCalls = (w: World) =>
  w.net.calls.filter((call) => call.url.startsWith("https://api.telegram.org/"))
    .length;

describe("the calls of a thing that leaves a topic", () => {
  /** A world whose topic 900 Telegram doesn't find, and whose old messages it deletes no more. */
  async function lost(): Promise<World> {
    const w = await alarmed();
    withLostThread(w.net, 900).on("POST", /\/deleteMessage$/, () =>
      refused(TOO_OLD),
    );
    return w;
  }

  it("stay within SHOW_AGAIN as ⏰ Later brings it back", async () => {
    const w = await lost();
    const alarm = await alarmOf(w);
    await press(w.context, alarm, {
      action: "later",
      id: alarm.id,
      version: null,
    });
    w.clock.now = START + 4 * HOUR;
    const before = telegramCalls(w);
    expect(await runSchedule(w.context)).toEqual([alarm.id]);
    // The message into 900, the new topic and its message, the rename of 900, the
    // delete of 100 and its edit; the request asked getMe before.
    expect(telegramCalls(w) - before).toBe(6);
    expect(telegramCalls(w) - before).toBeLessThanOrEqual(SHOW_AGAIN);
  });

  it("stay within ALARM_CHANGE as a new entry brings the alarm into a new topic", async () => {
    const w = await lost();
    w.clock.now = START + QUIET;
    const before = telegramCalls(w);
    await apply(w.context, failing("workflow:release"));
    // The edit, the notice into 900, the new topic and its message, the rename of
    // 900, the delete of 100 and its edit, and the notice in 901.
    expect(telegramCalls(w) - before).toBe(8);
    expect(telegramCalls(w) - before).toBeLessThanOrEqual(ALARM_CHANGE);
  });
});
