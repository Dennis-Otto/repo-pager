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

Each event that GitHub delivers, each update of Telegram and each run of the schedule is one request of the Worker. Over that limit, Cloudflare answers every request with its error 1027 before the Worker runs, which the daily *Health* check of the control repository sees as a 429. Over any other limit, the operation fails inside the Worker: the pager then tells you once that day in Telegram, as far as it still can, and its answer to the health check names the limit (`src/limits.ts`). An event that failed comes again with the schedule once the limit reset, as [How it works](how-it-works.md#when-an-event-fails) describes.

## What each kind of event costs

The Worker checks the signature of a delivery and reads the rules itself, so an event that means nothing costs its request alone. Only an event that means something goes on to the one Durable Object, which reads and writes Workers KV.

| Delivery | Worker | Durable Object | KV reads | KV writes |
| --- | --- | --- | --- | --- |
| A run on `main` passed, while its workflow fails nowhere | 1 | 1 | 1 | 0 |
| A run on `main` was cancelled | 1 | 1 | 1 | 0 |
| A run on `main` skipped its jobs | 1 | 0 | 0 | 0 |
| A run on `main` failed, which waits for its rerun | 1 | 1 | 1 | 1 |
| A run passed on a pull request, at its head, which may be its visual check | 1 | 1 | 0 | 0 |
| A run of a pull request that failed, or of another branch | 1 | 0 | 0 | 0 |
| A run of a release that isn't ready to merge | 1 | 1 | 0 | 0 |
| A pull request or a comment of the maintainer or of a bot | 1 | 0 | 0 | 0 |
| A delivery of *Workflow run* or *Check run*, from an app that still has them | 1 | 0 | 0 | 0 |

A run comes as the end of its check suite: GitHub sends that event once per run, where *Workflow run* comes three times per run and *Check run* twice for each job, about 14 deliveries per run of five jobs. The pager reads the run of a suite that can mean something, one call of GitHub, which costs nothing of Cloudflare's limits. A failure that shows after its rerun didn't help writes its thing and the link of its topic, two writes.

A run of the schedule, every 15 minutes, is a request of the Worker and of the Durable Object and writes two rows of its storage, its time and what it read of the deliveries. It reads nothing of Workers KV while nothing is due: a note in the storage of the Durable Object keeps when the next thing is due, a thing put aside with ⏰ Later or a text that waits for its answer, and the run lists the records only then, and every six hours all the same.

## A busy day

On 2026-11-16, the ten repositories of the maintainer ran 11,746 runs of GitHub Actions, and the pager of 0.10.1 used up the free plan, as on three more days of that week. The kinds of the runs come from a sample of 3,957 of them; the other events are estimates from the 99 pull requests and 6 issues opened that day.

| | Before | Now |
| --- | --- | --- |
| Deliveries, requests of the Worker | about 160,000 | about 13,200 |
| Requests of the Durable Object | about 160,000 | about 7,900 |
| Reads of Workers KV | thousands, one per pass of a job on `main` | about 6,800 |
| Lists of Workers KV | 96 | at most 4 while nothing is due |

That is below a third of each limit. The busiest day of that week, 2026-11-13, ran 36,380 runs: about 41,000 requests of the Worker, still below half of each limit.

Most of those runs are runs of the blueprint's workflows that a `workflow_run` starts and that skip their jobs: they cost a request each and nothing more. A fleet with more runs than that can still use up the requests of the Worker, since each run is one delivery; a Workers Paid plan has no daily limit of requests.
