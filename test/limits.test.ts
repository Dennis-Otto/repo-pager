// When a daily limit of the free plan of Cloudflare is used up all the same: the
// pager tells its maintainer once that day, as far as it still can, the log and
// the health check name the limit, and the event fails, so that the schedule has
// GitHub deliver it again after the limit reset.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describe as describeError } from "../src/context.ts";
import { hmacHex } from "../src/crypto.ts";
import { health } from "../src/health.ts";
import worker from "../src/index.ts";
import {
  forgetTold,
  LIMIT_HIT,
  limitOf,
  noteLimit,
  tellLimit,
  tellsNow,
} from "../src/limits.ts";
import { deliver, schedule } from "../src/routes.ts";
import type { PagerEnv } from "../src/settings.ts";
import { appKey, CHAT, Net, START, world } from "./helpers.ts";

/** The error of Workers KV once its writes of the day are used up. */
const WRITES = new Error("KV put() limit exceeded for the day.");

const { MAINTAINER_LOGIN: OWNER } = env as PagerEnv;

afterEach(() => {
  vi.restoreAllMocks();
  forgetTold();
});

describe("the limit that an error names", () => {
  it("knows each operation of Workers KV, and the Durable Object", () => {
    expect(limitOf(new Error("KV get() limit exceeded for the day."))).toBe(
      "kvReads",
    );
    expect(limitOf(WRITES)).toBe("kvWrites");
    expect(limitOf(new Error("KV delete() limit exceeded for the day."))).toBe(
      "kvDeletes",
    );
    expect(limitOf(new Error("KV list() limit exceeded for the day."))).toBe(
      "kvLists",
    );
    expect(
      limitOf(
        new Error(
          "Exceeded allowed volume of requests in Durable Objects free tier.",
        ),
      ),
    ).toBe("objects");
  });

  it("is none for any other error", () => {
    expect(limitOf(new TypeError("Network connection lost"))).toBeNull();
    expect(
      limitOf(new Error("KV PUT failed: 429 Too Many Requests")),
    ).toBeNull();
    expect(limitOf("KV put() limit exceeded for the day.")).toBeNull();
  });

  it("goes into the log by its name, and nothing else of the error", () => {
    expect(describeError(WRITES)).toBe(
      "the daily limit of the free plan of Cloudflare: kvWrites",
    );
  });
});

describe("the message of a limit", () => {
  it("comes once a day, and the health check names the limit", async () => {
    const w = await world({ language: "de" });
    await tellLimit(w.context, "kvWrites");
    await tellLimit(w.context, "kvReads");
    const sent = w.net.telegram("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.text).toContain("Schreibzugriffe auf Workers KV");
    expect((await health(w.context)).limit).toEqual({
      limit: "kvWrites",
      at: new Date(START).toISOString(),
    });
    // The next day, it comes again.
    w.clock.now = START + 24 * 60 * 60 * 1000;
    await tellLimit(w.context, "kvReads");
    expect(w.net.telegram("sendMessage")).toHaveLength(2);
    expect(w.net.telegram("sendMessage")[1]?.body.text).toContain(
      "Lesezugriffe",
    );
  });

  it("comes after a delivery, a Telegram update or a run of the schedule that hit a limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = await world();
    vi.spyOn(w.context.store, "get").mockRejectedValue(WRITES);
    const response = await deliver(w.context, {
      event: "issues",
      signal: {
        repo: `${OWNER}/demo`,
        installation: 9,
        type: "contribution",
        number: 1,
        pull: false,
        title: "Hi",
        url: "https://github.com/x",
        author: "octocat",
      },
    });
    expect(response.status).toBe(500);
    expect(w.net.telegram("sendMessage")).toHaveLength(1);
    expect(w.net.telegram("sendMessage")[0]?.body.text).toContain(
      "the writes of Workers KV",
    );
    // A run of the schedule that fails as a whole tells too, the same day not again.
    vi.spyOn(w.context, "exclusive").mockRejectedValueOnce(WRITES);
    await schedule(w.context);
    expect(w.net.telegram("sendMessage")).toHaveLength(1);
    expect(await w.context.local.get(LIMIT_HIT)).toMatchObject({
      limit: "kvWrites",
    });
  });

  it("goes to the log alone when Telegram refuses it, and an error of no limit tells nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = await world();
    await noteLimit(w.context, new TypeError("Network connection lost"));
    expect(w.net.calls).toEqual([]);
    vi.spyOn(w.context.telegram, "say").mockRejectedValueOnce(
      new TypeError("Network connection lost"),
    );
    await noteLimit(w.context, WRITES);
    expect(error).toHaveBeenCalledWith(
      "The pager couldn't tell of the limit kvWrites:",
      "TypeError",
    );
    vi.spyOn(w.context.local, "get").mockRejectedValueOnce("gone");
    await noteLimit(w.context, WRITES);
    expect(error).toHaveBeenCalledWith(
      "The pager couldn't tell of the limit kvWrites:",
      "unknown error",
    );
  });
});

describe("a Durable Object that refuses the Worker", () => {
  async function refused(error: unknown): Promise<Response> {
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 9 },
      repository: { full_name: `${OWNER}/demo`, owner: { login: OWNER } },
      issue: {
        number: 1,
        title: "Hi",
        html_url: "https://github.com/x",
        user: { login: "octocat" },
      },
    });
    const environment = {
      ...(env as PagerEnv),
      SERIAL: {
        getByName: () => ({
          deliver: () => Promise.reject(error),
        }),
      },
      TELEGRAM_BOT_TOKEN: "123:test",
      TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
      TELEGRAM_CHAT_ID: String(CHAT),
      GITHUB_WEBHOOK_SECRET: "github-secret",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: (await appKey()).pem,
      CONTROL_SECRET: "control-secret",
    } as unknown as PagerEnv;
    return worker.fetch(
      new Request("https://pager.example/github", {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-hub-signature-256": `sha256=${await hmacHex("github-secret", body)}`,
        },
        body,
      }) as Request<unknown, IncomingRequestCfProperties>,
      environment,
    );
  }

  it("tells of its limit from the Worker itself, once a day in an isolate, and fails the event", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const net = new Net();
    vi.spyOn(globalThis, "fetch").mockImplementation(net.fetch);
    const limit = new Error(
      "Exceeded allowed volume of requests in Durable Objects free tier.",
    );
    expect((await refused(limit)).status).toBe(500);
    expect((await refused(limit)).status).toBe(500);
    expect(net.telegram("sendMessage")).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(
      "A GitHub issues failed:",
      "the daily limit of the free plan of Cloudflare: objects",
    );
    // Any other error tells nothing.
    forgetTold();
    expect((await refused(new TypeError("gone"))).status).toBe(500);
    expect(net.telegram("sendMessage")).toHaveLength(1);
  });

  it("goes to the log alone when Telegram refuses the message", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const net = new Net().on("POST", /\/sendMessage$/, () => {
      throw new TypeError("Network connection lost");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(net.fetch);
    await refused(WRITES);
    expect(errors).toHaveBeenCalledWith(
      "The pager couldn't tell of the limit kvWrites:",
      "TypeError",
    );
  });

  it("tells once per day", () => {
    expect(tellsNow(START)).toBe(true);
    expect(tellsNow(START + 1000)).toBe(false);
    expect(tellsNow(START + 24 * 60 * 60 * 1000)).toBe(true);
  });
});
