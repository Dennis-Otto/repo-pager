# Costs

The pager runs on the free plan of Cloudflare, whose limits count per day and reset at 00:00 UTC. This page says what each limit is, what each kind of event costs, and how far a busy day of a real fleet of repositories stays below them. `test/costs.test.ts` measures each number here through the Worker as Cloudflare runs it, and fails when a change makes a kind of event dearer or the day no longer fits.

## The limits of the free plan

| Limit | A day | Source |
| --- | --- | --- |
| Requests of the Worker | 100,000 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Requests of the Durable Object | 100,000 | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Duration of the Durable Object | 13,000 GB-s | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Rows written by the storage of the Durable Object | 100,000 | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Reads of Workers KV | 100,000 | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Writes of Workers KV | 1,000 | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Deletes of Workers KV | 1,000 | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Lists of Workers KV | 1,000 | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Events of Workers Logs | 200,000 | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Ingestion of Observability, the events of Workers Logs and the traces together, from 2026-12-01 | 0.5 GB | [Observability pricing](https://developers.cloudflare.com/observability/pricing/) |

Each event that GitHub delivers, each update of Telegram and each run of the schedule is one request of the Worker. Over that limit, Cloudflare answers every request with its error 1027 before the Worker runs, which the daily *Health* check of the control repository sees as a 429. Over any other limit, the operation fails inside the Worker: the pager then tells you once that day in Telegram, as far as it still can, and its answer to the health check carries the limit in its field `limit` (`src/limits.ts`). An event that failed comes again with the schedule once the limit reset, as [How it works](how-it-works.md#when-an-event-fails) describes.

## What each kind of event costs

The Worker checks the signature of a delivery and reads the rules itself, so an event that means nothing costs its request alone. Only an event that means something goes on to the one Durable Object, which reads and writes Workers KV.

| Delivery | Worker | Durable Object | KV reads | KV writes |
| --- | --- | --- | --- | --- |
| A run on `main` passed, while its workflow fails nowhere | 1 | 1 | 1 | 0 |
| A run on `main` was cancelled | 1 | 1 | 1 | 0 |
| A run on `main` skipped its jobs | 1 | 0 | 0 | 0 |
| A run on `main` failed, which waits for its rerun | 1 | 1 | 1 | 1 |
| A run passed on a pull request, at its head, which may be its visual check | 1 | 1 | 0 | 0 |
| A run of a pull request that failed | 1 | 0 | 0 | 0 |
| A run of a tag or of a branch without a pull request that failed or passed, such as the verification of a release | 1 | 1 | 2 | 0 |
| A run of a release that isn't ready to merge | 1 | 1 | 0 | 0 |
| A pull request or a comment of the maintainer or of a bot | 1 | 0 | 0 | 0 |
| A delivery of *Workflow run* or *Check run*, from an app that still has them | 1 | 0 | 0 | 0 |

A run comes as the end of its check suite: GitHub sends that event once per run, where *Workflow run* comes three times per run and *Check run* twice for each job, about 14 deliveries per run of five jobs. The pager reads the run of a suite that can mean something, one call of GitHub, which costs nothing of Cloudflare's limits. A failure that shows after its rerun didn't help writes its thing and the link of its topic, two writes. A run of a tag or of a branch without a pull request is read as well, since a release workflow such as the verification of a release published by hand runs there; a fleet whose checks run on pull requests has few of them.

Without *Check run*, the pager no longer sees a failing check of another app than GitHub Actions on `main`, such as an outside CI: the runs of GitHub Actions page through their check suites, the checks of other apps don't. Tick *Check run* if such a check should page you; it costs two requests of the Worker per job of every run.

A run of the schedule, every 15 minutes, is a request of the Worker and of the Durable Object and writes two rows of its storage, its time and what it read of the deliveries. It reads nothing of Workers KV while nothing is due: a note in the storage of the Durable Object keeps when the next thing is due, a thing put aside with ⏰ Later or a text that waits for its answer, and the run lists the records only then, and every six hours all the same.

The topic of a thing that is done goes in such a run, once the hours of `DONE_TOPIC_HOURS` are over, and costs no request of its own: the write that makes the thing done notes when, in the metadata of its record, so the note of what is due wakes the list only when a topic is due, and each deleted topic costs one read and one write of Workers KV and one call of Telegram, ten topics per run at most. A press of 🗑 Delete topic is a request of the Worker and of the Durable Object, like any press, with the same read and write.

## A busy day

On 2026-11-16, the ten repositories of the maintainer ran 11,746 runs of GitHub Actions, and the pager of 0.10.1 used up the free plan, as on three more days of that week. The kinds of the runs come from a sample of 3,957 of them; the other events are estimates from the 99 pull requests and 6 issues opened that day.

| | Before | Now |
| --- | --- | --- |
| Deliveries, requests of the Worker | about 160,000 | about 13,200 |
| Requests of the Durable Object | about 160,000 | about 7,900 |
| Reads of Workers KV | thousands, one per pass of a job on `main` | about 6,800 |
| Lists of Workers KV | 96 | at most 4 while nothing is due |
| Events of Workers Logs | about 320,000 | none while nothing fails, about 23,600 should every delivery that means something fail |

That is below a third of each limit. The busiest day of that week, 2026-11-13, ran 36,380 runs: about 41,000 requests of the Worker, still below half of each limit.

Workers Logs keeps an event for each line that the Worker or the Durable Object logs, and by default one more for each request of either, its invocation log. The pager logs a line only when something fails, and `wrangler.jsonc` turns the invocation logs off, so a day on which nothing fails writes no event at all; with them, the busy day wrote about 21,100. Should every delivery that means something fail all day, in each of its three attempts, such as while GitHub is down, the day writes about 23,600 events, below a third of the 200,000, and at a generous 4 KB an event about 97 MB, below a third of the 0.5 GB that Cloudflare counts from 2026-12-01. On the busiest day of the week, every line would still be kept. `test/costs.test.ts` holds both.

Most of those runs are runs of the blueprint's workflows that a `workflow_run` starts and that skip their jobs: they cost a request each and nothing more. A fleet with more runs than that can still use up the requests of the Worker, since each run is one delivery; a Workers Paid plan has no daily limit of requests.

## Workers Logs

Cloudflare counts each event of Workers Logs against a daily allowance, and once it is used up, it takes no more events until the allowance resets at 00:00 UTC: the very lines that tell why something failed would be lost. So the pager keeps only those, and all of them. The `observability` block of `wrangler.jsonc` says so, and `test/costs.test.ts` fails when it no longer does:

| Setting | Value | What it does |
| --- | --- | --- |
| `enabled` | `true` | Workers Logs keeps the logs of the Worker. |
| `head_sampling_rate` | `1` | Every request keeps its lines, none is left out by chance: a failure is never the one that a sample dropped. |
| `logs.invocation_logs` | `false` | No event for each request of the Worker and each call of the Durable Object, only the lines that the pager logs. |
| `traces.enabled` | `false` | No traces, whose spans count against the same allowance of Observability. |

The settings are those of [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and of the [configuration of Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/#observability). A lower `head_sampling_rate` would save events too, but it drops whole requests at random, failures with them, so the pager doesn't use it.

### What you still see

- **Each failure, with why,** in the Logs of the Worker on the dashboard of Cloudflare, for three days, seven from 2026-12-01: the line names the event of GitHub, the update of Telegram or the run of the schedule that failed, and the answer that made it fail, such as `A GitHub check_suite failed: GitHub answered 503: unavailable`. A delivery that failed for good becomes an entry of the alarm of the control repository, as [How it works](how-it-works.md#when-an-event-fails) describes.
- **Each delivery of GitHub and the pager's answer to it,** with its status, in the recent deliveries on the *Advanced* page of your GitHub App, where you can also deliver one again.
- **The requests, the errors and the time of the Worker and of the Durable Object,** in the metrics of the Worker on the dashboard, which count nothing against the allowance of Observability.
- **Every request live,** with its invocation log, in `npx wrangler tail` or the live view of the Logs while you watch; Cloudflare keeps none of them.

What you no longer see is a stored entry for each request that went well: for a request of the past that didn't fail, the recent deliveries of the app are the record.
