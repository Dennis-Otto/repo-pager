// What the pager costs on the free plan of Cloudflare: each kind of delivery of
// the GitHub App goes through the Worker as Cloudflare runs it, and the test
// counts what it takes of each daily limit of src/limits.ts: the requests of the
// Worker and of its Durable Object, the reads, writes, deletes and lists of Workers
// KV, the rows that the storage of the object writes, and the events and bytes of
// Workers Logs as wrangler.jsonc configures it. Then it holds a busy day of a real
// fleet below a third of each limit, and fails when a change makes a kind of event
// dearer. docs/costs.md explains the numbers.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import text from "../github-app.json?raw";
import { Memory, makeContext } from "../src/context.ts";
import { hmacHex } from "../src/crypto.ts";
import { MAX_ATTEMPTS } from "../src/deliveries.ts";
import {
  DUE,
  type Due,
  earlier,
  idle,
  LAG,
  noteListed,
  noteSoon,
  SAFETY,
} from "../src/due.ts";
import { forget } from "../src/github.ts";
import worker from "../src/index.ts";
import { LIMITS } from "../src/limits.ts";
import { WAIT } from "../src/pager.ts";
import { type Delivered, deliver, schedule, serve } from "../src/routes.ts";
import { ANSWER_WITHIN } from "../src/schedule.ts";
import {
  doneTopicHoursOf,
  type PagerEnv,
  type Settings,
} from "../src/settings.ts";
import { type Item, itemId, keys } from "../src/store.ts";
import {
  LINK_LIFE,
  SWEEP,
  SWEEP_DELETES,
  SWEEP_PAGE,
  SWEEP_WRITES,
  type Sweep,
} from "../src/sweep.ts";
import { languageOf, texts } from "../src/texts.ts";
import { remindTokens } from "../src/tokens.ts";
import { topicName } from "../src/topics.ts";
import wrangler from "../wrangler.jsonc?raw";
import {
  appKey,
  CHAT,
  json,
  Net,
  START,
  settings as settingsOf,
  withTopics,
} from "./helpers.ts";

/** What one delivery, or one run of the schedule, takes of each daily limit. */
interface Cost {
  requests: number;
  objects: number;
  kvReads: number;
  kvWrites: number;
  kvDeletes: number;
  kvLists: number;
  rowsWritten: number;
  /**
   * Events of Workers Logs: each line logged, and one per request of the Worker or
   * of the object where wrangler.jsonc keeps the logs of the invocations.
   */
  logs: number;
  /** Bytes that those events take of the ingestion of Cloudflare Observability. */
  ingested: number;
}

const FREE: Cost = { ...LIMITS };

function nothing(): Cost {
  return {
    requests: 0,
    objects: 0,
    kvReads: 0,
    kvWrites: 0,
    kvDeletes: 0,
    kvLists: 0,
    rowsWritten: 0,
    logs: 0,
    ingested: 0,
  };
}

/** The operations of Workers KV, by the limit that each counts against. */
const KV: Record<string, keyof Cost> = {
  get: "kvReads",
  getWithMetadata: "kvReads",
  put: "kvWrites",
  delete: "kvDeletes",
  list: "kvLists",
};

const { MAINTAINER_LOGIN: OWNER } = env as PagerEnv;
const HERE = `${OWNER}/demo`;
const repository = {
  full_name: HERE,
  default_branch: "main",
  owner: { login: OWNER },
};

let cost: Cost;
let net: Net;
let clock: { now: number };
let local: Memory;

/**
 * The Worker's environment, with Workers KV and the storage of the Durable Object
 * counted, and an object that runs the pager's own code with them, as src/serial.ts
 * does, and counts each call of the Worker on it.
 */
async function counted(): Promise<PagerEnv> {
  const kv = new Proxy(env.PAGER, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const limit = KV[String(name)];
        if (limit !== undefined) {
          cost[limit] += 1;
        }
        return value.apply(target, args);
      };
    },
  });
  const counting: PagerEnv = { ...(env as PagerEnv), PAGER: kv };
  const storage = {
    get: <T>(key: string) => local.get<T>(key),
    put: <T>(key: string, value: T) => {
      cost.rowsWritten += 1;
      return local.put(key, value);
    },
  };
  const context = (settings: Settings) =>
    makeContext(
      settings,
      counting,
      net.fetch,
      () => clock.now,
      async () => {},
      undefined,
      storage,
    );
  const object = {
    handle(
      settings: Settings,
      route: "/telegram" | "/control",
      request: Request,
    ) {
      cost.objects += 1;
      return serve(context(settings), route, request);
    },
    deliver(settings: Settings, delivered: Delivered) {
      cost.objects += 1;
      return deliver(context(settings), delivered);
    },
    schedule(settings: Settings) {
      cost.objects += 1;
      return schedule(context(settings));
    },
  };
  return {
    ...counting,
    SERIAL: {
      getByName: () => object,
    } as unknown as PagerEnv["SERIAL"],
    TELEGRAM_BOT_TOKEN: "123:test",
    TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
    TELEGRAM_CHAT_ID: String(CHAT),
    GITHUB_WEBHOOK_SECRET: "github-secret",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: (await appKey()).pem,
    CONTROL_SECRET: "control-secret",
    GITHUB_USER_TOKEN: "user-token",
  } as PagerEnv;
}

/** The methods of the console, each line of which is an event of Workers Logs. */
const LOGGED = ["log", "info", "warn", "error", "debug"] as const;

/** The spies on those methods, for the test that runs. */
let spies: { mock: { calls: unknown[] } }[] = [];

/** The lines logged so far in this test. */
function lines(): number {
  return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

/** The settings of Workers Logs in wrangler.jsonc. */
interface Observability {
  enabled?: boolean;
  head_sampling_rate?: number;
  logs?: {
    enabled?: boolean;
    head_sampling_rate?: number;
    invocation_logs?: boolean;
  };
  traces?: { enabled?: boolean };
  issues?: { enabled?: boolean };
}

/** The observability of wrangler.jsonc, whose comments take whole lines. */
const OBSERVABILITY = (
  JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, "")) as {
    observability?: Observability;
  }
).observability;

/**
 * Whether Workers Logs keeps an event for each invocation, of the Worker and of
 * the Durable Object, besides one for each line that either logs: by default it
 * does, and `invocation_logs: false` turns it off.
 */
const INVOCATIONS = OBSERVABILITY?.logs?.invocation_logs !== false;

/**
 * A generous size of one event of Workers Logs, for the ingestion of Cloudflare
 * Observability, which counts the uncompressed size of each event with the
 * attributes that Cloudflare adds to it: the pager's lines are short, and the test
 * of a failure below holds each under a tenth of this.
 */
const EVENT_BYTES = 4_096;

function logged(before: number): void {
  cost.logs =
    (INVOCATIONS ? cost.requests + cost.objects : 0) + lines() - before;
  cost.ingested = cost.logs * EVENT_BYTES;
}

/** Deliver one event of the GitHub App, signed, and return what it cost. */
async function price(
  event: string,
  payload: object,
  status = 200,
): Promise<Cost> {
  const environment = await counted();
  const body = JSON.stringify({
    installation: { id: 9 },
    repository,
    ...payload,
  });
  cost = nothing();
  cost.requests += 1;
  const before = lines();
  const response = await worker.fetch(
    new Request("https://pager.example/github", {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${await hmacHex("github-secret", body)}`,
      },
      body,
    }) as Request<unknown, IncomingRequestCfProperties>,
    environment,
  );
  expect(response.status).toBe(status);
  logged(before);
  return cost;
}

/** One run of the schedule, as its cron starts it, and what it cost. */
async function scheduled(): Promise<Cost> {
  const environment = await counted();
  cost = nothing();
  cost.requests += 1;
  const before = lines();
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({} as ScheduledController, environment, {
    waitUntil: (work: Promise<unknown>) => waits.push(work),
  } as never);
  await Promise.all(waits);
  logged(before);
  return cost;
}

/** A run of GitHub Actions, as GitHub lists it for its check suite. */
function run(extra: object = {}) {
  return {
    id: 60,
    name: "Docs",
    path: ".github/workflows/docs.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${HERE}/actions/runs/60`,
    head_branch: "main",
    head_sha: "abc",
    head_repository: { full_name: HERE },
    pull_requests: [],
    run_attempt: 1,
    ...extra,
  };
}

/** The check suite of a run of GitHub Actions that ended. */
function suite(extra: object = {}) {
  return {
    action: "completed",
    check_suite: {
      id: 600,
      head_branch: "main",
      head_sha: "abc",
      conclusion: "success",
      app: { slug: "github-actions" },
      pull_requests: [],
      ...extra,
    },
  };
}

/** GitHub answers the run of the check suite with this run. */
function runs(found: object) {
  net.on("GET", /\/actions\/runs\?check_suite_id=600&per_page=1$/, () =>
    json({ workflow_runs: [found] }),
  );
}

const job = (conclusion: string) => ({
  action: "completed",
  check_run: {
    name: "lint",
    conclusion,
    html_url: `https://github.com/${HERE}/actions/runs/60/job/7`,
    check_suite: { head_branch: "main" },
  },
});

beforeEach(async () => {
  forget();
  const listed = await env.PAGER.list();
  await Promise.all(listed.keys.map((each) => env.PAGER.delete(each.name)));
  net = new Net();
  withTopics(net);
  clock = { now: START };
  local = new Memory();
  spies = LOGGED.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Only the request of the Worker, which answers it itself. */
const ANSWERED: Cost = { ...nothing(), requests: 1 };

/** A request that the Durable Object serves, which reads one record. */
const ONE_READ: Cost = {
  ...nothing(),
  requests: 1,
  objects: 1,
  kvReads: 1,
};

/**
 * What each kind of delivery costs, measured: the kinds of a fleet's busy day,
 * with what the pager does with each. A change that makes one dearer fails here
 * first: then the budget below says whether the day still fits.
 */
const MEASURED: Record<string, () => Promise<Cost>> = {
  "check_suite: a run on main passed, while its workflow fails nowhere": () => {
    runs(run());
    return price("check_suite", suite());
  },
  "check_suite: a run on main was cancelled": () => {
    runs(run({ conclusion: "cancelled" }));
    return price("check_suite", suite({ conclusion: "cancelled" }));
  },
  "check_suite: a run on main skipped its jobs": () =>
    price("check_suite", suite({ conclusion: "skipped" })),
  "check_suite: a run on main failed, which waits for its rerun": () => {
    runs(run({ conclusion: "failure" }));
    net.on("GET", /\/actions\/runs\/60\/attempts\/1\/jobs/, () =>
      json({
        jobs: [
          { name: "lint", html_url: "https://x/7", conclusion: "failure" },
        ],
      }),
    );
    return price("check_suite", suite({ conclusion: "failure" }));
  },
  "check_suite: a run passed on a pull request, at its head": () => {
    runs(
      run({
        event: "pull_request",
        head_branch: "feat/blue",
        pull_requests: [{ number: 8, head: { sha: "abc" } }],
      }),
    );
    return price(
      "check_suite",
      suite({
        head_branch: "feat/blue",
        pull_requests: [{ number: 8, head: { sha: "abc" } }],
      }),
    );
  },
  "check_suite: a run of a pull request that failed": () =>
    price(
      "check_suite",
      suite({
        head_branch: "feat/blue",
        conclusion: "failure",
        pull_requests: [{ number: 8, head: { sha: "abc" } }],
      }),
    ),
  "check_suite: a run of a tag or of a branch without a pull request, such as the verification of a release":
    () => {
      runs(
        run({
          path: ".github/workflows/verify-release.yml",
          event: "release",
          head_branch: "v1.2.0",
        }),
      );
      return price(
        "check_suite",
        suite({ head_branch: "v1.2.0", conclusion: "success" }),
      );
    },
  "check_suite: a run of a release that isn't ready to merge": () => {
    net.on("GET", `/repos/${HERE}/pulls/30`, () =>
      json({
        number: 30,
        state: "open",
        title: "chore: release 1.2.3",
        head: { ref: "release-please--branches--main", sha: "abc" },
        base: { ref: "main" },
        mergeable_state: "blocked",
      }),
    );
    return price(
      "check_suite",
      suite({
        head_branch: "release-please--branches--main",
        pull_requests: [{ number: 30 }],
      }),
    );
  },
  "pull_request: of the maintainer or of a bot": () =>
    price("pull_request", {
      action: "labeled",
      pull_request: {
        number: 7,
        user: { login: "renovate[bot]", type: "Bot" },
        head: { ref: "renovate/x", repo: { full_name: HERE } },
      },
    }),
  "issue_comment: of the maintainer or of a bot": () =>
    price("issue_comment", {
      action: "edited",
      issue: { number: 7, user: { login: OWNER }, pull_request: {} },
      comment: { id: 1, user: { login: "github-actions[bot]", type: "Bot" } },
    }),
  "workflow_run: any, where the app still sends it": () =>
    price("workflow_run", { action: "completed", workflow_run: run() }),
  "check_run: a job of GitHub Actions, where the app still sends it": () =>
    price("check_run", job("success")),
};

/** What each kind costs, as MEASURED finds it. */
const EXPECTED: Record<keyof typeof MEASURED, Cost> = {
  "check_suite: a run on main passed, while its workflow fails nowhere":
    ONE_READ,
  "check_suite: a run on main was cancelled": ONE_READ,
  "check_suite: a run on main skipped its jobs": ANSWERED,
  "check_suite: a run on main failed, which waits for its rerun": {
    ...ONE_READ,
    kvWrites: 1,
  },
  "check_suite: a run passed on a pull request, at its head": {
    ...nothing(),
    requests: 1,
    objects: 1,
  },
  "check_suite: a run of a pull request that failed": ANSWERED,
  "check_suite: a run of a tag or of a branch without a pull request, such as the verification of a release":
    // The record of the thing and the alarm of the repository.
    { ...ONE_READ, kvReads: 2 },
  "check_suite: a run of a release that isn't ready to merge": {
    ...nothing(),
    requests: 1,
    objects: 1,
  },
  "pull_request: of the maintainer or of a bot": ANSWERED,
  "issue_comment: of the maintainer or of a bot": ANSWERED,
  "workflow_run: any, where the app still sends it": ANSWERED,
  "check_run: a job of GitHub Actions, where the app still sends it": ANSWERED,
};

describe("the cost of each kind of delivery", () => {
  for (const [kind, measure] of Object.entries(MEASURED)) {
    it(kind, async () => {
      expect(await measure()).toEqual(EXPECTED[kind]);
    });
  }

  it("a failure on main that shows after its rerun didn't help", async () => {
    // The run of the schedule after WAIT reads the run, which failed again.
    runs(run({ conclusion: "failure" }));
    net
      .on("GET", /\/actions\/runs\/60\/attempts\/1\/jobs/, () =>
        json({
          jobs: [
            { name: "lint", html_url: "https://x/7", conclusion: "failure" },
          ],
        }),
      )
      .on("GET", `/repos/${HERE}/actions/runs/60`, () =>
        json(run({ conclusion: "failure" })),
      );
    await price("check_suite", suite({ conclusion: "failure" }));
    clock.now += WAIT;
    const shown = await scheduled();
    // Its message: the record of the thing, and the link of its topic.
    expect(net.telegram("sendMessage")).toHaveLength(1);
    expect(shown.kvWrites).toBe(2);
    expect(shown.kvLists).toBe(1);
  });
});

describe("the schedule", () => {
  const QUARTER = 15 * 60_000;
  // Once the sweep of the topics done before this version is through: while it
  // goes, its runs cost a list of their own, which "a busy day" prices
  // (src/sweep.ts).
  beforeEach(async () => {
    await local.put<Sweep>(SWEEP, {
      first: START,
      start: START,
      deleted: 0,
      ended: START,
    });
  });
  /** The KV operations of a run, none while nothing is due. */
  const kv = (each: Cost) =>
    each.kvReads + each.kvWrites + each.kvDeletes + each.kvLists;

  it("costs no operation of Workers KV while nothing is due", async () => {
    // The first run after a deploy lists, and finds nothing due.
    expect(await scheduled()).toMatchObject({ kvLists: 1, kvReads: 1 });
    clock.now += QUARTER;
    expect(await scheduled()).toEqual({
      ...nothing(),
      requests: 1,
      objects: 1,
      // The time of the run, which the health check reads, and what the run
      // read of the deliveries of the webhook.
      rowsWritten: 2,
    });
  });

  it("lists again when a thing that was put aside is due, and not before", async () => {
    await scheduled();
    const store = makeContext(
      await settingsOf(),
      env as PagerEnv,
      net.fetch,
      () => clock.now,
      async () => {},
      undefined,
      local,
    ).store;
    await store.put({
      id: "i00000000000001",
      repo: HERE,
      installation: 9,
      messageId: 7,
      note: null,
      kind: "alarm",
      state: "open",
      entries: [{ key: "bot:1", label: "A bot fails", url: "https://x" }],
      snoozedUntil: START + 4 * QUARTER,
    });
    // The write noted its time: the runs before it cost nothing.
    for (const quarter of [1, 2, 3]) {
      clock.now = START + quarter * QUARTER;
      expect(kv(await scheduled())).toBe(0);
    }
    clock.now = START + 4 * QUARTER;
    expect(await scheduled()).toMatchObject({ kvLists: 1 });
    const back = await env.PAGER.get<{ snoozedUntil: number | null }>(
      "item:i00000000000001",
      "json",
    );
    expect(back?.snoozedUntil).toBeNull();
  });

  it("lists every six hours, whatever the note says", async () => {
    await scheduled();
    clock.now += SAFETY - QUARTER;
    expect(kv(await scheduled())).toBe(0);
    clock.now += QUARTER;
    expect(await scheduled()).toMatchObject({ kvLists: 1 });
  });

  it("deletes the topic of a done thing in the run that is due, at one read and one write, and costs nothing before", async () => {
    await scheduled();
    // The hours of the instance, which another instance sets as well.
    const hours = doneTopicHoursOf(env.DONE_TOPIC_HOURS) as number;
    const store = makeContext(
      { ...(await settingsOf()), doneTopicHours: hours },
      env as PagerEnv,
      net.fetch,
      () => clock.now,
      async () => {},
      undefined,
      local,
    ).store;
    await store.put({
      id: "i00000000000002",
      repo: HERE,
      installation: 9,
      messageId: 7,
      note: null,
      kind: "alarm",
      state: "recovered",
      entries: [],
      snoozedUntil: null,
      topic: { thread: 900, name: "✅ 🚨 demo" },
      doneAt: START,
    });
    const due = START + hours * 4 * QUARTER;
    // The write noted its time: a run before it costs nothing.
    if (due > START + QUARTER) {
      clock.now = START + QUARTER;
      expect(kv(await scheduled())).toBe(0);
    }
    clock.now = due;
    // The list, the texts that wait and the record; its write; and one call of Telegram.
    expect(await scheduled()).toMatchObject({
      kvLists: 1,
      kvReads: 2,
      kvWrites: 1,
      kvDeletes: 0,
    });
    expect(
      net.calls.filter((call) => call.url.endsWith("/deleteForumTopic")),
    ).toHaveLength(1);
  });

  it("reads the texts that wait only when one may be late", async () => {
    await scheduled();
    const context = makeContext(
      await settingsOf(),
      env as PagerEnv,
      net.fetch,
      () => clock.now,
      async () => {},
      undefined,
      local,
    );
    await context.store.ask(500, clock.now, null);
    clock.now += QUARTER;
    expect(await scheduled()).toMatchObject({ kvReads: 1, kvLists: 1 });
    clock.now += QUARTER;
    expect(kv(await scheduled())).toBe(0);
    // An hour after it went, its 👀 becomes 😢.
    clock.now = START + ANSWER_WITHIN + QUARTER;
    expect(await scheduled()).toMatchObject({ kvReads: 1, kvWrites: 1 });
    expect(net.telegram("setMessageReaction")).toHaveLength(1);
  });
});

/** Press a button of the message shownIn, as Telegram sends the press, and return what it cost. */
async function pressed(data: string, shownIn: number): Promise<Cost> {
  const environment = await counted();
  const body = JSON.stringify({
    update_id: 1,
    callback_query: {
      id: "q1",
      from: { id: CHAT },
      data,
      message: { message_id: shownIn, chat: { id: CHAT } },
    },
  });
  cost = nothing();
  cost.requests += 1;
  const before = lines();
  const response = await worker.fetch(
    new Request("https://pager.example/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      body,
    }) as Request<unknown, IncomingRequestCfProperties>,
    environment,
  );
  expect(response.status).toBe(200);
  logged(before);
  return cost;
}

describe("a notice and its button ⬇️ Show", () => {
  const ID = "i000000000000003";
  const store = async () =>
    makeContext(
      await settingsOf(),
      env as PagerEnv,
      net.fetch,
      () => clock.now,
      async () => {},
      undefined,
      local,
    ).store;
  /** An alarm in its topic 900 as message 7, in a state of the test's own. */
  const alarm = (state: "open" | "recovered" | "ignored"): Item => {
    const item = {
      id: ID,
      repo: HERE,
      installation: 9,
      messageId: 7,
      note: null,
      kind: "alarm",
      state,
      entries: [{ key: "check:lint", label: "lint fails", url: "https://x" }],
      snoozedUntil: null,
      topic: { thread: 900, name: "" },
    } as Item;
    // Named as the language of the instance names it, so that no rename follows.
    const t = texts(languageOf((env as PagerEnv).LANGUAGE) ?? "en");
    item.topic = { thread: 900, name: topicName(item, t) };
    return item;
  };
  /** The methods of Telegram that the pager called, in order. */
  const methods = () =>
    net.calls
      .filter((call) => call.url.startsWith("https://api.telegram.org/"))
      .map((call) => call.url.slice(call.url.lastIndexOf("/") + 1));

  it("costs nothing more for the notice: the edit of the thing's message and one sendMessage, as before", async () => {
    const url = `https://github.com/${HERE}/issues/12`;
    const issue = {
      id: await itemId(keys.contribution(HERE, 12)),
      repo: HERE,
      installation: 9,
      messageId: 7,
      note: null,
      kind: "contribution",
      state: "new",
      number: 12,
      pull: false,
      title: "It breaks",
      url,
      author: "octocat",
      draft: null,
      draftVersion: 0,
      snoozedUntil: null,
      topic: { thread: 900, name: "" },
    } as Item;
    const t = texts(languageOf((env as PagerEnv).LANGUAGE) ?? "en");
    issue.topic = { thread: 900, name: topicName(issue, t) };
    await (await store()).put(issue);
    expect(
      await price("issue_comment", {
        action: "created",
        issue: {
          number: 12,
          title: "It breaks",
          html_url: url,
          user: { login: "octocat", type: "User" },
          state: "open",
        },
        comment: {
          id: 99,
          html_url: `${url}#issuecomment-99`,
          user: { login: "hubot", type: "User" },
        },
      }),
    ).toMatchObject({
      requests: 1,
      objects: 1,
      kvReads: 1,
      kvWrites: 1,
      kvDeletes: 0,
      kvLists: 0,
    });
    expect(methods()).toEqual(["editMessageText", "sendMessage"]);
    expect(
      net.telegram("sendMessage")[0]?.body.reply_markup.inline_keyboard,
    ).toHaveLength(1);
  });

  it("costs one read and one write of Workers KV for a press, with one request of the Worker and one of the object", async () => {
    await (await store()).put(alarm("open"));
    expect(await pressed(`show:${ID}`, 50)).toMatchObject({
      requests: 1,
      objects: 1,
      kvReads: 1,
      kvWrites: 1,
      kvDeletes: 0,
      kvLists: 0,
    });
    expect(methods()).toEqual([
      "sendMessage",
      "deleteMessage",
      "answerCallbackQuery",
      "editMessageReplyMarkup",
    ]);
  });

  it("costs one more call of Telegram, and nothing more of Workers KV, when Telegram deletes the old message no more", async () => {
    await (await store()).put(alarm("open"));
    net.on("POST", /\/deleteMessage$/, () =>
      json(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: message can't be deleted for everyone",
        },
        400,
      ),
    );
    expect(await pressed(`show:${ID}`, 50)).toMatchObject({
      kvReads: 1,
      kvWrites: 1,
    });
    expect(methods()).toEqual([
      "sendMessage",
      "deleteMessage",
      "editMessageText",
      "answerCallbackQuery",
      "editMessageReplyMarkup",
    ]);
  });

  it("costs one read and no write for a press that is refused", async () => {
    for (const state of ["recovered", "ignored"] as const) {
      net.calls = [];
      await (await store()).put(alarm(state));
      expect(await pressed(`show:${ID}`, 50)).toMatchObject({
        requests: 1,
        objects: 1,
        kvReads: 1,
        kvWrites: 0,
      });
      expect(methods()).toEqual([
        "answerCallbackQuery",
        "editMessageReplyMarkup",
      ]);
    }
  });
});

/** Send a body of the control repository, signed, and return what it cost. */
async function controlled(value: object, status = 200): Promise<Cost> {
  const environment = await counted();
  const body = JSON.stringify(value);
  const stamp = String(Math.floor(clock.now / 1000));
  cost = nothing();
  cost.requests += 1;
  const before = lines();
  const response = await worker.fetch(
    new Request("https://pager.example/control", {
      method: "POST",
      headers: {
        "x-pager-timestamp": stamp,
        "x-pager-signature": `sha256=${await hmacHex("control-secret", `${stamp}.${body}`)}`,
      },
      body,
    }) as Request<unknown, IncomingRequestCfProperties>,
    environment,
  );
  expect(response.status).toBe(status);
  logged(before);
  return cost;
}

/**
 * What a report of a run in its topic costs, with 🗑 Delete topic: its post, with
 * the pause of new topics read and its record written, and the row of the note of
 * what is due that its hours lower; and what the run of the schedule that deletes
 * its topic once they are over costs beyond a run with nothing due: the list, the
 * texts that wait, the record and its delete, with one call of Telegram, and the
 * list and the texts that wait of the next run, which lists once more, as after
 * the topic of any done thing, with a row of the note of each.
 */
const REPORT: { posted: Cost; cleared: Cost } = {
  posted: {
    ...nothing(),
    requests: 1,
    objects: 1,
    kvReads: 1,
    kvWrites: 1,
    rowsWritten: 1,
  },
  cleared: {
    ...nothing(),
    kvReads: 3,
    kvDeletes: 1,
    kvLists: 2,
    rowsWritten: 2,
  },
};

describe("the report of a run", () => {
  const QUARTER = 15 * 60_000;
  const REPORTED = { type: "report", title: "Night", text: "Done." };
  // Once the sweep of the topics done before this version is through.
  beforeEach(async () => {
    await local.put<Sweep>(SWEEP, {
      first: START,
      start: START,
      deleted: 0,
      ended: START,
    });
  });
  /** The methods of Telegram that the pager called, in order. */
  const methods = () =>
    net.calls
      .filter((call) => call.url.startsWith("https://api.telegram.org/"))
      .map((call) => call.url.slice(call.url.lastIndexOf("/") + 1));

  it("costs one read and one write of Workers KV in its topic, and three calls of Telegram", async () => {
    // The note of what is due, which the first run makes.
    await scheduled();
    net.calls = [];
    expect(await controlled(REPORTED)).toEqual(REPORT.posted);
    expect(methods()).toEqual(["getMe", "createForumTopic", "sendMessage"]);
  });

  it("costs nothing of Workers KV in the main view of a chat without topics, as before", async () => {
    net = new Net();
    expect(await controlled(REPORTED)).toEqual({
      ...nothing(),
      requests: 1,
      objects: 1,
    });
    expect(methods()).toEqual(["getMe", "sendMessage"]);
  });

  it("deletes its topic in the run that is due, at one list, two reads, one delete and one call, and the next run lists once more", async () => {
    const hours = doneTopicHoursOf(env.DONE_TOPIC_HOURS) as number;
    await scheduled();
    await controlled(REPORTED);
    const due = START + hours * 4 * QUARTER;
    clock.now = due - QUARTER;
    await scheduled();
    clock.now = due;
    net.calls = [];
    const run = await scheduled();
    expect(methods()).toEqual(["deleteForumTopic"]);
    expect((await env.PAGER.list({ prefix: "item:" })).keys).toEqual([]);
    // The next run lists once more, since the list of the run before still named
    // the report, and finds nothing due; the runs after it are idle.
    clock.now += QUARTER;
    const again = await scheduled();
    expect(again).toMatchObject({ kvLists: 1, kvDeletes: 0, kvWrites: 0 });
    clock.now += QUARTER;
    const idle = await scheduled();
    expect(idle).toEqual({
      ...nothing(),
      requests: 1,
      objects: 1,
      rowsWritten: 2,
    });
    const extra = nothing();
    for (const limit of Object.keys(extra) as (keyof Cost)[]) {
      extra[limit] = run[limit] + again[limit] - 2 * idle[limit];
    }
    expect(extra).toEqual(REPORT.cleared);
  });
});

describe("the note of what is due", () => {
  it("takes the earlier of two moments, either of which may be none", () => {
    expect(earlier(null, null)).toBeNull();
    expect(earlier(5, null)).toBe(5);
    expect(earlier(null, 5)).toBe(5);
    expect(earlier(5, 3)).toBe(3);
  });

  it("is made by the first list, and a write without it changes nothing", async () => {
    await noteSoon(local, 5, 1);
    expect(await local.get(DUE)).toBeUndefined();
    expect(await idle(local, 1)).toBe(false);
    await noteListed(local, 10, null);
    expect(await local.get<Due>(DUE)).toEqual({
      next: null,
      marked: 0,
      listed: 10,
    });
    expect(await idle(local, 11)).toBe(true);
  });

  it("keeps a write that came just before a list, which the list may miss", async () => {
    await noteListed(local, 0, null);
    await noteSoon(local, 500, 1000);
    await noteListed(local, 1000 + LAG, 900);
    expect((await local.get<Due>(DUE))?.next).toBe(500);
    // A list long after the write found all there is.
    await noteListed(local, 1000 + LAG + 1, 900);
    expect((await local.get<Due>(DUE))?.next).toBe(900);
  });
});

/**
 * A busy day of a real fleet: the ten repositories of the maintainer on
 * 2026-11-16, a day on which the pager of 0.10.1 used up the free plan. GitHub
 * Actions ran 11,746 runs that day, and each is one check suite, here by its
 * kind, from a sample of 3,957 of those runs. The other events are estimates from
 * the 99 pull requests and 6 issues opened that day, each pull request with ten
 * events of its own and four comments.
 */
const DAY = {
  suites: {
    "check_suite: a run on main passed, while its workflow fails nowhere": 4533,
    "check_suite: a run on main was cancelled": 2220,
    "check_suite: a run on main skipped its jobs": 2113,
    "check_suite: a run on main failed, which waits for its rerun": 18,
    "check_suite: a run passed on a pull request, at its head": 606,
    "check_suite: a run of a pull request that failed": 1826,
    "check_suite: a run of a release that isn't ready to merge": 430,
  },
  others: {
    "pull_request: of the maintainer or of a bot": 990,
    "issue_comment: of the maintainer or of a bot": 400,
  },
  /** The runs of the schedule, every 15 minutes. */
  schedules: 96,
  /**
   * The reports of runs of the maintainer's own agents, such as those of a night,
   * each in a topic of its own, which goes in a run of the schedule of its own.
   */
  reports: 10,
};

/** The busiest day of that week, 2026-11-13, with 36,380 runs. */
const BUSIEST = 36_380 / 11_746;

describe("a busy day of a fleet", () => {
  async function day(scale = 1): Promise<Cost> {
    const total = nothing();
    const add = (each: Cost, times: number) => {
      for (const limit of Object.keys(total) as (keyof Cost)[]) {
        total[limit] += Math.ceil(each[limit] * times * scale);
      }
    };
    for (const [kind, times] of Object.entries({
      ...DAY.suites,
      ...DAY.others,
    })) {
      add(EXPECTED[kind] as Cost, times);
    }
    // A run of the schedule as it runs all day: after the first, which lists,
    // and with the lists that come every SAFETY all the same.
    await scheduled();
    clock.now += 15 * 60_000;
    add(await scheduled(), DAY.schedules);
    add({ ...nothing(), kvLists: 1, kvReads: 1 }, (24 * 60 * 60_000) / SAFETY);
    add(REPORT.posted, DAY.reports);
    add(REPORT.cleared, DAY.reports);
    return total;
  }

  it("takes the 11,746 runs that the fleet ran on it as as many deliveries, not 14 times as many", () => {
    const runs = Object.values(DAY.suites).reduce((a, b) => a + b);
    expect(runs).toBe(11_746);
  });

  it("stays below a third of each daily limit of the free plan", async () => {
    const total = await day();
    // The numbers of docs/costs.md.
    expect(total).toEqual({
      requests: 13_242,
      objects: 7_913,
      kvReads: 6_815,
      kvWrites: 28,
      kvDeletes: 10,
      kvLists: 24,
      rowsWritten: 222,
      // A day on which nothing fails logs nothing: 21,135 events, before
      // wrangler.jsonc turned off the logs of the invocations.
      logs: 0,
      ingested: 0,
    });
    for (const limit of Object.keys(FREE) as (keyof Cost)[]) {
      expect(total[limit], limit).toBeLessThan(FREE[limit] / 3);
    }
  });

  it("stays below the limits on the busiest day of the week, three times as busy", async () => {
    const total = await day(BUSIEST);
    for (const limit of Object.keys(FREE) as (keyof Cost)[]) {
      expect(total[limit], limit).toBeLessThan(FREE[limit] / 2);
    }
  });

  const DAY_MS = 24 * 60 * 60_000;
  // The environment of the tests, whose CLAUDE_TOKEN_EXPIRES a test may change.
  const vars = env as { CLAUDE_TOKEN_EXPIRES: string };

  /**
   * What a day of the sweep of the topics done before this version adds, each of
   * its 96 runs at every bound of src/sweep.ts at once: a page of links, each of
   * which takes two reads, the most topics that a run deletes, and the most
   * records that it writes. The day itself is the same, so the sweep adds only
   * what its run costs beyond a run without it. Its first run is at `start`, by
   * default the clock of the machine, by which Workers KV keeps the time of expiry
   * of a link.
   */
  async function sweepDay(start = Date.now()): Promise<Cost> {
    // The reminder of the token of Claude, in the 21 days before
    // CLAUDE_TOKEN_EXPIRES, is a thing of its own that each later run reads, and
    // has nothing to do with the sweep: without it, the day of the sweep costs the
    // same on every date, as with the settings of another instance.
    const expires = vars.CLAUDE_TOKEN_EXPIRES;
    vars.CLAUDE_TOKEN_EXPIRES = "";
    try {
      return await sweptFrom(start);
    } finally {
      vars.CLAUDE_TOKEN_EXPIRES = expires;
    }
  }

  async function sweptFrom(start: number): Promise<Cost> {
    const hours = doneTopicHoursOf(env.DONE_TOPIC_HOURS) as number;
    const settings = { ...(await settingsOf()), doneTopicHours: hours };
    clock.now = start;
    const first = clock.now;
    // The first run notes when the sweep starts.
    await scheduled();
    const uncounted = () =>
      makeContext(
        settings,
        env as PagerEnv,
        net.fetch,
        () => clock.now,
        async () => {},
        undefined,
        local,
      );
    const { store } = uncounted();
    // The first run of a UTC day checks GITHUB_USER_TOKEN, with a row of its own,
    // which a day counts once, sweep or not. Before each of the two runs that are compared, the
    // step of the tokens has its turn at the time of that run, uncounted, so that
    // neither carries the row of the day, wherever 00:00 UTC falls.
    const tokensOfTheDay = () =>
      remindTokens(uncounted(), async (_thing, work) => {
        await work();
        return true;
      });
    // A link that was done a day before the first run, and lives 29 days more.
    const expiration = Math.floor((first - DAY_MS + LINK_LIFE) / 1000);
    const thing = (thread: number, state: string): Item =>
      ({
        id: `i0000000000${thread}`,
        repo: HERE,
        installation: 9,
        messageId: 7,
        note: null,
        kind: "alarm",
        state,
        entries: [],
        snoozedUntil: null,
        topic: { thread, name: "🚨 demo" },
      }) as Item;
    const kept = SWEEP_PAGE - SWEEP_DELETES;
    for (let index = 0; index < SWEEP_PAGE + 5; index += 1) {
      const thread = 1000 + index;
      const id = `i0000000000${thread}`;
      if (index >= SWEEP_PAGE) {
        // Links of open things, without a time of expiry, on the next page.
        await env.PAGER.put(`topic:${thread}`, id);
        continue;
      }
      await env.PAGER.put(`topic:${thread}`, id, { expiration });
      if (index < kept) {
        // Things that opened again: two reads each, and they stay.
        await store.put(thing(thread, "open"));
      } else if (index < kept + SWEEP_WRITES) {
        // Things done before this version: their topic goes, with a write.
        await store.put(thing(thread, "recovered"));
      }
      // The rest are gone: their topic goes without a write.
    }
    // The run before the start lists, as every six hours.
    clock.now = first + hours * 60 * 60_000 - 15 * 60_000;
    await scheduled();
    clock.now += 15 * 60_000;
    await tokensOfTheDay();
    const run = await scheduled();
    expect(
      net.calls.filter((call) => call.url.endsWith("/deleteForumTopic")),
    ).toHaveLength(SWEEP_DELETES);
    expect((await local.get<Sweep>(SWEEP))?.deleted).toBe(SWEEP_DELETES);
    // Once it is through, a run costs what it did without it.
    await local.put<Sweep>(SWEEP, {
      ...((await local.get<Sweep>(SWEEP)) as Sweep),
      ended: clock.now,
    });
    clock.now += 15 * 60_000;
    await tokensOfTheDay();
    const after = await scheduled();
    expect(after).toEqual({
      ...nothing(),
      requests: 1,
      objects: 1,
      rowsWritten: 2,
    });
    const extra = nothing();
    for (const limit of Object.keys(extra) as (keyof Cost)[]) {
      extra[limit] = (run[limit] - after[limit]) * DAY.schedules;
    }
    return extra;
  }

  /** The numbers of docs/costs.md: a list, 40 reads, 3 writes and a row a run. */
  const swept = (): Cost => ({
    ...nothing(),
    kvReads: 2 * SWEEP_PAGE * DAY.schedules,
    kvWrites: SWEEP_WRITES * DAY.schedules,
    kvLists: DAY.schedules,
    rowsWritten: DAY.schedules,
  });

  it("stays below a third of each daily limit with a day of the sweep of the old topics", async () => {
    const extra = await sweepDay();
    expect(extra).toEqual(swept());
    clock.now = START;
    local = new Memory();
    const total = await day();
    for (const limit of Object.keys(FREE) as (keyof Cost)[]) {
      expect(total[limit] + extra[limit], limit).toBeLessThan(FREE[limit] / 3);
    }
  });

  // The two runs that are compared come at the start of the sweep, DONE_TOPIC_HOURS
  // after the first run, and a quarter of an hour after it, and the run before them
  // a quarter of an hour before the start of the sweep: 00:00 UTC falls the given
  // minutes before the start of the sweep.
  it.each([
    ["before the run before the start", 30],
    ["between the run before the start and the run at it", 5],
    ["between the run at the start and the run after it", -5],
    ["after the three runs", -30],
  ])(
    "costs as much with a day of the sweep whatever the time, with 00:00 UTC %s",
    async (_, minutes) => {
      const hours = doneTopicHoursOf(env.DONE_TOPIC_HOURS) as number;
      // The next 00:00 UTC by the clock of the machine, by which Workers KV keeps
      // the times of expiry of the links.
      const midnight = (Math.floor(Date.now() / DAY_MS) + 1) * DAY_MS;
      const start = midnight - hours * 60 * 60_000 + minutes * 60_000;
      expect(await sweepDay(start)).toEqual(swept());
    },
  );

  it.each([
    ["before the sweep", 30],
    ["between the compared runs", -5],
  ])(
    "costs as much with a day of the sweep in the days of the reminder of the Claude token, from 00:00 UTC %s",
    async (_, minutes) => {
      const hours = doneTopicHoursOf(env.DONE_TOPIC_HOURS) as number;
      const midnight = (Math.floor(Date.now() / DAY_MS) + 1) * DAY_MS;
      // From this 00:00 UTC on, the token of Claude expires in 21 days.
      const expires = vars.CLAUDE_TOKEN_EXPIRES;
      vars.CLAUDE_TOKEN_EXPIRES = new Date(midnight + 21 * DAY_MS)
        .toISOString()
        .slice(0, 10);
      try {
        const start = midnight - hours * 60 * 60_000 + minutes * 60_000;
        expect(await sweepDay(start)).toEqual(swept());
        expect(vars.CLAUDE_TOKEN_EXPIRES).not.toBe("");
      } finally {
        vars.CLAUDE_TOKEN_EXPIRES = expires;
      }
    },
  );

  it("stays below the limits on the busiest day of the week with a day of the sweep", async () => {
    const extra = await sweepDay();
    clock.now = START;
    local = new Memory();
    const total = await day(BUSIEST);
    for (const limit of Object.keys(FREE) as (keyof Cost)[]) {
      expect(total[limit] + extra[limit], limit).toBeLessThan(FREE[limit] / 2);
    }
  });

  it("subscribes to none of the events that the budget leaves out", () => {
    const manifest = JSON.parse(text) as { default_events: string[] };
    const budgeted = new Set(
      [...Object.keys(DAY.suites), ...Object.keys(DAY.others)].map(
        (kind) => kind.split(":")[0],
      ),
    );
    // Each event that the app receives is either in the day of the budget or one
    // of a few a day: issues, discussions, reviews, releases and alerts.
    const few = new Set([
      "code_scanning_alert",
      "discussion",
      "discussion_comment",
      "issues",
      "pull_request_review",
      "pull_request_review_comment",
      "release",
      "repository_advisory",
      "secret_scanning_alert",
    ]);
    for (const event of manifest.default_events) {
      expect(budgeted.has(event) || few.has(event), event).toBe(true);
    }
  });
});

describe("Workers Logs", () => {
  it("keeps every line that the pager logs, and no event for each invocation", () => {
    // wrangler.jsonc: logs on, unsampled, without the logs of the invocations,
    // and nothing else that counts against the allowance of Observability.
    expect(OBSERVABILITY?.enabled).toBe(true);
    expect(OBSERVABILITY?.head_sampling_rate ?? 1).toBe(1);
    expect(OBSERVABILITY?.logs?.head_sampling_rate ?? 1).toBe(1);
    expect(OBSERVABILITY?.logs?.enabled ?? true).toBe(true);
    expect(INVOCATIONS).toBe(false);
    expect(OBSERVABILITY?.traces?.enabled ?? false).toBe(false);
    expect(OBSERVABILITY?.issues?.enabled ?? false).toBe(false);
  });

  /** A run on main whose check suite the pager can't read: GitHub fails. */
  async function failing(): Promise<Cost> {
    net.on(
      "GET",
      /\/actions\/runs\?check_suite_id=600&per_page=1$/,
      () => new Response("unavailable", { status: 503 }),
    );
    return price("check_suite", suite({ conclusion: "failure" }), 500);
  }

  it("logs a delivery that failed in a line that tells which and why", async () => {
    const failed = await failing();
    expect(failed.logs).toBe(1);
    const said = spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => (args as unknown[]).map(String).join(" "));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("check_suite");
    expect(said[0]).toContain("503");
    // Short, as EVENT_BYTES assumes.
    expect((said[0] as string).length).toBeLessThan(EVENT_BYTES / 10);
  });

  /**
   * The events of a day on which every delivery that the Durable Object serves
   * fails, as the one of failing() does, in each of its attempts, and each run of
   * the schedule logs a line and fails: GitHub or Telegram down all day.
   */
  async function failingDay(scale: number): Promise<number> {
    const failed = await failing();
    const served = Object.entries({ ...DAY.suites, ...DAY.others }).reduce(
      (sum, [kind, times]) => sum + (EXPECTED[kind] as Cost).objects * times,
      0,
    );
    return Math.ceil(
      (served * MAX_ATTEMPTS * failed.logs + DAY.schedules * 2) * scale,
    );
  }

  it("stays below a third of its allowances on the busy day, should every delivery that means something fail", async () => {
    const events = await failingDay(1);
    expect(events).toBe(23_613);
    expect(events).toBeLessThan(FREE.logs / 3);
    expect(events * EVENT_BYTES).toBeLessThan(FREE.ingested / 3);
  });

  it("keeps every line on the busiest day of the week too, should every such delivery fail", async () => {
    const events = await failingDay(BUSIEST);
    expect(events).toBeLessThan(FREE.logs / 2);
    expect(events * EVENT_BYTES).toBeLessThan(FREE.ingested);
  });
});
