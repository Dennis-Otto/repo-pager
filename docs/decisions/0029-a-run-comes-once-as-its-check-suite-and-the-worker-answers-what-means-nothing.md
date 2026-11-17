# A run comes once, as its check suite, and the Worker answers what means nothing

- Status: accepted
- Date: 2026-11-17

## Context

The pager runs on the free plan of Cloudflare, whose limits are daily: 100,000 requests of the Worker, 100,000 requests of the Durable Object, and of Workers KV 100,000 reads and 1,000 writes, deletes and lists ([Costs](../costs.md) cites them). Its maintainer's fleet of ten repositories used them up on four days of one week: Cloudflare mailed each day, and while the requests were used up, Cloudflare answered every request with its error 1027 before the Worker ran, so the pager took no event and no button, and the daily *Health* check of the control repository failed with a 429.

The cause was the events that the app asked for. Each run of GitHub Actions came as three events `workflow_run` (requested, in progress, completed), two events `check_run` per job (created, completed) and one event `check_suite`: about 14 deliveries per run, since a run had about five jobs. On 2026-11-16, the fleet ran 11,746 runs, about 160,000 deliveries, and each went on from the Worker to the Durable Object, a second request, before a rule looked at it. Most meant nothing: 22 % of the runs skipped every job, and a running job or a run that started never pages.

## Options

1. **Keep the events, answer faster:** read the rules in the Worker, before the Durable Object. It halves what a delivery costs, but the requests of the Worker stay at 160,000.
2. **Drop only `check_run`:** the rules need it only for a required check of another app than GitHub Actions. That leaves three deliveries per run, about 35,000 on that day and over 100,000 on the busiest day of the week, 2026-11-13, with 36,380 runs.
3. **One event per run, its check suite:** GitHub sends `check_suite` completed once per run, since each run of GitHub Actions is one check suite of the app `github-actions`, and again when a rerun ends, which the suite of the run keeps. The suite says its branch, its head, its conclusion and its pull requests, but not its workflow, so the pager reads the run of the suite where the run can mean something.
4. **Poll the runs in the schedule:** no delivery at all, but a failure would wait up to 15 minutes, as would the pictures of a visual check, and the schedule's 50 calls per run would have to cover every repository.

## Decision

Options 1 and 3 together. The Worker checks the signature of a delivery first, as before, then reads the rules of `src/rules.ts` itself and answers what means nothing at once, with no call of Workers KV and none of the Durable Object; only a signal goes on to the object. The app asks for `check_suite` and no longer for `workflow_run` or `check_run`. A check suite of GitHub Actions that ended is a signal only where its run can mean something: on the default branch a failure, a pass or a cancel, and on a pull request of the repository itself a pass at its head, which may be its visual check. Then the pager reads the run of the suite, one call of GitHub, and the run means what its own event meant, by the same `finishedRun()` that reads the run of a bot-health issue. A delivery of `workflow_run` or of a job of GitHub Actions, from an app that still sends them, is answered in the Worker.

With it, the schedule lists the records of Workers KV only when the note of what is due, in the storage of the Durable Object, says that one is due, or every six hours, and a daily limit that is used up all the same tells the maintainer once that day, as far as the pager still can, and the health answer names it.

## Consequences

On the day of 2026-11-16, the Worker takes about 13,000 requests instead of about 160,000, and the Durable Object about 8,000; on the busiest day of the week, about 41,000 and 24,500, below the limits. `test/costs.test.ts` measures what each kind of delivery costs and holds that day below a third of each limit, and fails when a change makes a kind dearer. A pass on `main` costs a call of GitHub and a read of Workers KV, as the event of the run did before. The end of a rerun comes as the suite of its run ending again; should GitHub not send it, the schedule reads the run of a failure that waits, as it did before for a rerun whose event was missed. A required check of another app than GitHub Actions pages only for an app that keeps *Check run*, which each user ticks by hand, as `docs/setup.md` says. An entry that a pager before 0.7.0 kept for a job of GitHub Actions no longer leaves with the pass of that job, which every pass since 0.7.0 has done. The apps that exist drop the two events by hand, in their settings: the release notes say how.
