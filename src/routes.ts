/**
 * The routes of the pager: the webhook of Telegram, that of the GitHub App and the
 * answers of the control repository. Each request proves where it comes from
 * first. A delivery of GitHub is checked and read in the Worker itself, and only
 * one that means something goes on to the one Durable Object of the pager, since
 * a day of a fleet of repositories brings thousands that mean nothing, and each
 * call of the object counts against its own daily limit (docs/costs.md). What a
 * request then changes runs one at a time, through the exclusive of the context,
 * because the state in Workers KV has no compare-and-swap.
 */
import { describe } from "./context.ts";
import { handleControl } from "./control.ts";
import { safeEqual, verifySignature } from "./crypto.ts";
import { noteLimit } from "./limits.ts";
import { apply, type Context } from "./pager.ts";
import { classify, type Payload, type Signal } from "./rules.ts";
import { runSchedule } from "./schedule.ts";
import type { Settings } from "./settings.ts";
import { handleUpdate, type Update } from "./updates.ts";

export type Route = "/telegram" | "/github" | "/control";

/** A delivery of the GitHub App that means something: its event and its signal. */
export interface Delivered {
  event: string;
  signal: Signal;
}

async function telegram(context: Context, request: Request): Promise<Response> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(secret, context.settings.telegramSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  let update: Update;
  try {
    update = await request.json<Update>();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  try {
    await context.exclusive(() => handleUpdate(context, update));
  } catch (error) {
    // Telegram sends an update again until it gets a 200, and a button pressed
    // twice could act twice: the error goes to the log, and the update is done.
    console.error("A Telegram update failed:", describe(error));
    await noteLimit(context, error);
  }
  return new Response("ok");
}

/**
 * A delivery of the GitHub App, in the Worker, before the Durable Object: its
 * signature first, then what it means. The answer, when it means nothing, or what
 * it means, which the Durable Object then applies. The rules read only the event
 * and its payload, so this costs no call of the store and none of the object.
 */
export async function screen(
  settings: Settings,
  request: Request,
): Promise<Response | Delivered> {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!(await verifySignature(settings.githubSecret, body, signature))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const event = request.headers.get("x-github-event") ?? "";
  if (event === "ping") {
    return new Response("pong");
  }
  let payload: Payload;
  try {
    payload = JSON.parse(body) as Payload;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const outcome = classify(
    event,
    payload,
    settings.maintainer,
    settings.owners,
  );
  if ("ignored" in outcome) {
    return new Response(`ignored: ${outcome.ignored}`);
  }
  return { event, signal: outcome.signal };
}

/** Apply what a delivery of the GitHub App means, in the Durable Object. */
export async function deliver(
  context: Context,
  { event, signal }: Delivered,
): Promise<Response> {
  try {
    return new Response(await context.exclusive(() => apply(context, signal)));
  } catch (error) {
    // GitHub never delivers it again by itself: the schedule asks it to, three
    // attempts in all, and then pages (src/deliveries.ts).
    console.error(`A GitHub ${event} failed:`, describe(error));
    await noteLimit(context, error);
    return new Response("failed", { status: 500 });
  }
}

/**
 * Serve a request of Telegram or of the control repository that the Worker let
 * through: its method and route are known.
 */
export function serve(
  context: Context,
  route: Exclude<Route, "/github">,
  request: Request,
): Promise<Response> {
  return route === "/telegram"
    ? telegram(context, request)
    : context.exclusive(() => handleControl(context, request));
}

/** One run of the schedule; a failure goes to the log. */
export async function schedule(context: Context): Promise<void> {
  try {
    await context.exclusive(() => runSchedule(context));
  } catch (error) {
    console.error("The schedule failed:", describe(error));
    await noteLimit(context, error);
  }
}
