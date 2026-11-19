# Workers Logs keeps every line of a failure, and no log of each invocation

- Status: accepted, amends [0030](0030-a-run-comes-once-as-its-check-suite-and-the-worker-answers-what-means-nothing.md)
- Date: 2026-11-17

## Context

On 2026-11-16, Cloudflare told the maintainer that the Worker had used up three allowances of the free plan in one day: the requests of the Worker, the requests of the Durable Object, and Observability, after which it "stopped ingesting new Observability events until the allowance resets". [Decision 0030](0030-a-run-comes-once-as-its-check-suite-and-the-worker-answers-what-means-nothing.md) cut the deliveries and the calls of the Durable Object, and kept Workers Logs complete, without sampling: an event for each request of the Worker and of the Durable Object, and a line only on a failure, about 21,100 events on the busy day of `docs/costs.md`.

Those 21,100 events were almost all invocation logs: one per request, whatever it did, and the pager logs a line only when something fails. They say which deliveries came and how the Worker answered, which the recent deliveries of the GitHub App keep as well, and the metrics of the Worker count, outside the allowance of Observability. The allowance changes on 2026-12-01 from 200,000 events a day to 0.5 GB of ingestion a day, the uncompressed size of the events of Workers Logs and of the traces together ([Observability pricing](https://developers.cloudflare.com/observability/pricing/)); either way, once it is used up, the lines that tell why something failed are lost for the rest of the day.

The settings of Workers Logs ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/#observability)): `head_sampling_rate`, from 0 to 1, keeps that share of the requests with all their logs; `logs.invocation_logs: false` drops the invocation log of each request and keeps the lines logged; `traces.enabled` turns the traces on, which are off by default and count against the same allowance.

## Options

1. **Keep every invocation log,** as 0030 did. Complete, and about 21,100 events on the busy day; a fleet with more runs, or a delivery that the app still sends for nothing, spends the allowance on requests that went well.
2. **Sample,** such as `head_sampling_rate: 0.1`. A tenth of the events, but the sample drops whole requests at random, the lines of their failures with them: the one failure that the maintainer looks for may be the one that is gone.
3. **No invocation logs, every line:** `logs.invocation_logs: false` with `head_sampling_rate: 1`, and no traces.

## Decision

Option 3. Workers Logs keeps each line that the pager logs, which names what failed and why, and nothing for a request that went well: a day on which nothing fails writes no event. `test/costs.test.ts` reads the `observability` block of `wrangler.jsonc`, counts the events and their bytes, at a generous 4 KB an event, and holds a busy day on which every delivery that means something fails, in each of its three attempts, below a third of both allowances.

**Amended on 2026-11-20:** the 4 KB an event are not generous but about what an event of an invocation log took: for 2026-11-16, the usage page of Cloudflare Observability shows about 0.74 GB for the 200,000 events, 3.7 to 4 KB each. The busy day of failures stays at about 97 MB either way, and an event would have to take 7 KB to pass a third of the 0.5 GB. On 2026-11-18 and 19, the first whole days with the change, the page shows 0.00 GB.

## Consequences

An uncaught exception was reported on the invocation log, which is now gone, so the Worker catches every exception of a request and of the schedule and logs it as one line, and `test/index.test.ts` proves each path. The Logs of the Worker on the dashboard show the failures and nothing else; `docs/costs.md` says where the rest is: each delivery and its answer in the recent deliveries of the GitHub App, the requests and errors in the metrics of the Worker, and every request live in `npx wrangler tail`. A request of the past that went well has no stored log line of its own. A copy that keeps a `wrangler.jsonc` of its own takes the new block over by hand, as the release notes say. A new line logged on a path that doesn't fail makes `test/costs.test.ts` fail, as a new invocation log would.
