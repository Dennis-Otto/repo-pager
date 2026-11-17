// What the pager costs on the free plan of Cloudflare: each kind of delivery of
// the GitHub App goes through the Worker as Cloudflare runs it, and the test
// counts what it takes of each daily limit of src/limits.ts: the requests of the
// Worker and of its Durable Object, the reads, writes, deletes and lists of Workers
// KV, and the rows that the storage of the object writes. Then it holds a busy day
// of a real fleet below a third of each limit, and fails when a change makes a
// kind of event dearer. docs/costs.md explains the numbers.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import text from "../github-app.json?raw";
import { Memory, makeContext } from "../src/context.ts";
import { hmacHex } from "../src/crypto.ts";
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
  /** Events of Workers Logs: one per request of the Worker or of the object, and each line logged. */
  logs: number;
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

/**
 * Workers Logs keeps one event for each invocation, of the Worker and of the
 * Durable Object, and one for each line that either logs.
 */
function logged(before: number): void {
  cost.logs = cost.requests + cost.objects + lines() - before;
}

/** Deliver one event of the GitHub App, signed, and return what it cost. */
async function price(event: string, payload: object): Promise<Cost> {
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
  expect(response.status).toBe(200);
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
const ANSWERED: Cost = { ...nothing(), requests: 1, logs: 1 };

/** A request that the Durable Object serves, which reads one record. */
const ONE_READ: Cost = {
  ...nothing(),
  requests: 1,
  objects: 1,
  kvReads: 1,
  logs: 2,
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
    logs: 2,
  },
  "check_suite: a run of a pull request that failed": ANSWERED,
  "check_suite: a run of a tag or of a branch without a pull request, such as the verification of a release":
    // The record of the thing and the alarm of the repository.
    { ...ONE_READ, kvReads: 2 },
  "check_suite: a run of a release that isn't ready to merge": {
    ...nothing(),
    requests: 1,
    objects: 1,
    logs: 2,
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
      logs: 2,
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
      requests: 13_232,
      objects: 7_903,
      kvReads: 6_775,
      kvWrites: 18,
      kvDeletes: 0,
      kvLists: 4,
      rowsWritten: 192,
      logs: 21_135,
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
