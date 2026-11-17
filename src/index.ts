/**
 * Repo Pager: a Telegram bot on a Cloudflare Worker that tells its maintainer
 * only what needs them in their GitHub repositories, and acts on it with a button.
 *
 * The handlers of the Worker: the webhook of Telegram at /telegram, that of the
 * GitHub App at /github, the answers of the control repository at /control, and the
 * schedule. The Worker turns away what no route serves, and answers each delivery
 * of GitHub that means nothing itself; the one Durable Object of src/serial.ts runs
 * the rest, one change at a time. Each request proves where it comes from before
 * anything else runs, and no log names a secret or what an issue says.
 */
import { describe } from "./context.ts";
import { limitOf, limitText, tellsNow } from "./limits.ts";
import { type Delivered, type Route, screen } from "./routes.ts";
import { type PagerEnv, readSettings, type Settings } from "./settings.ts";
import { Telegram } from "./telegram.ts";
import { texts } from "./texts.ts";

export { Serial } from "./serial.ts";

const ROUTES: ReadonlySet<string> = new Set<Route>([
  "/telegram",
  "/github",
  "/control",
]);

function configured(env: PagerEnv): Settings | null {
  const read = readSettings(env);
  if ("missing" in read) {
    console.error("The pager misses settings:", read.missing.join(", "));
    return null;
  }
  return read.settings;
}

/** The one Durable Object of the pager. */
function serial(env: PagerEnv) {
  return env.SERIAL.getByName("pager");
}

/**
 * A delivery that means something, in the Durable Object. When the object refuses
 * it, such as over its daily limit, the Worker tells the maintainer itself, once a
 * day as far as it can, and answers 500, so that the schedule has GitHub deliver
 * the event again once the object takes requests.
 */
async function deliver(
  env: PagerEnv,
  settings: Settings,
  delivered: Delivered,
): Promise<Response> {
  try {
    return await serial(env).deliver(settings, delivered);
  } catch (error) {
    console.error(`A GitHub ${delivered.event} failed:`, describe(error));
    const limit = limitOf(error);
    if (limit !== null && tellsNow(Date.now())) {
      try {
        await new Telegram(settings.telegramToken, settings.chatId, (...call) =>
          fetch(...call),
        ).say(limitText(texts(settings.language, settings.timeZone), limit));
      } catch (untold) {
        console.error(
          `The pager couldn't tell of the limit ${limit}:`,
          describe(untold),
        );
      }
    }
    return new Response("failed", { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" && ["GET", "HEAD"].includes(request.method)) {
      return new Response("ok");
    }
    if (!ROUTES.has(url.pathname)) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    const settings = configured(env);
    if (settings === null) {
      return new Response("Service Unavailable", { status: 503 });
    }
    if (url.pathname === "/github") {
      const screened = await screen(settings, request);
      return screened instanceof Response
        ? screened
        : deliver(env, settings, screened);
    }
    return serial(env).handle(
      settings,
      url.pathname as Exclude<Route, "/github">,
      request,
    );
  },

  async scheduled(_controller, env, executionContext) {
    const settings = configured(env);
    if (settings !== null) {
      executionContext.waitUntil(serial(env).schedule(settings));
    }
  },
} satisfies ExportedHandler<PagerEnv>;
