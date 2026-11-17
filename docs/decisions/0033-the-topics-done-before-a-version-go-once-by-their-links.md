# The topics done before a version go once, by their links

- Status: accepted, amends [0031](0031-a-done-topic-goes-with-a-button-and-after-the-hours-of-the-instance.md)
- Date: 2026-11-17

## Context

[Decision 0031](0031-a-done-topic-goes-with-a-button-and-after-the-hours-of-the-instance.md) let a done topic go with 🗑 Delete topic and after `DONE_TOPIC_HOURS`, but only for what is done from 0.11.0 on: the schedule finds a topic that is due by the done mark in the metadata of its record, which a thing gets only with its next change. Every topic that was done before stayed, with ✅ and without the button, and 0031 left them to the maintainer, by hand. On the maintainer's instance that was the whole pile since topics came, on 2026-11-04; he wanted to see only what is open, and to delete hundreds of topics one by one on a phone is no answer.

The topic of a release was lost even to a mark. A repository has one record of its release: when the next version comes after one was published, the new record starts without the old topic, which is then known only from its link `topic:<thread>`. That still happened after 0.11.0, whenever the next release pull request came within the hours of the one before.

Telegram's Bot API has no method that lists the topics of a chat: the pager knows a topic only from what it kept in Workers KV. The link of a done topic expires 30 days after its ✅, and the record of a closed thing 30 days after its last write, so the oldest of the pile would be out of reach from 2026-12-04 on.

The free plan of Cloudflare allows a day 1,000 writes and 1,000 lists of Workers KV, among others, and the pager had used it up on four days of one week before #242 and 0.11.1. A run of the schedule holds the queue of the Durable Object, so whatever the pager does there must also stay short.

## Options

1. **Leave the old topics to the maintainer,** as 0031 did: no cost, and a pile that only a phone and patience clear.
2. **Give the old things their mark and button,** with a read and a write of every closed record: the button needs an edit of each message as well, the pile takes the writes of days, and the orphaned topics of releases stay, since no record names them.
3. **One sweep through the links of the topics, by the pager itself,** bounded for each run and ended for good once through. The link is the one place that knows every topic, the orphaned ones included, and its time of expiry less 30 days is when its topic got its ✅.

## Decision

Option 3. On an instance that sets `DONE_TOPIC_HOURS`, the first run of the schedule of the new version notes when it ran, in the storage of the Durable Object, and the sweep starts the hours of the instance after it, so every old topic is past its hours, as a new one would be. It takes only the links that were written as done before that first run: what is done since has its mark, and the schedule deletes it itself. For each, the record decides. A thing that names this topic, is done and has no mark loses its topic as after a press of 🗑 Delete topic, with one call of Telegram and one write. A thing that is gone, or names another topic or none, loses nothing, and the topic goes with one call and no write. Anything else stays: an open thing, a thing with its mark, a link without a time of expiry, and the main view, which no link names; the sweep sends no message.

Each run takes one list of 20 links, at most ten deletions and three writes, and only the calls to the network that the other steps left, as its last step. Its day adds 96 lists, 3,840 reads, 288 writes and 96 rows of the Durable Object to the busy day of `test/costs.test.ts`, which holds the sum below a third of each limit: 100 lists, 10,615 reads and 306 writes. At 288 things a day, a pile of a few thousand is through before the oldest links expire, where two writes a run would have taken half as long again. The storage of the Durable Object keeps the cursor of its page, the last key it handled, the key that Telegram refused and since when, and its end: a list of Workers KV has no "start after", so a run that stopped in a page lists it again and skips the keys up to the last one handled. A refusal of Telegram ends the run without a write; the next run tries the same key, and after a day the sweep goes past it, the topic stays, and the log says so once. Once the list is through, or 30 days after the first run, when no such link can be left, the sweep notes its end, logs how many topics it deleted, and costs only the look at that note.

Without `DONE_TOPIC_HOURS`, nothing happens: no sweep, no button under the old things, no operation of Workers KV. Such an instance chose to keep its done topics; should it set the hours later, the sweep runs once then, over what its links still know.

So that no new orphans pile up, a new version of a release that follows one that is done keeps the topic of that one in its record, with when it was done, until the schedule deleted it once its hours are over, with a refusal tried for a day as any other. The done mark in the metadata of the record is the earliest of its own and those it keeps, so the list of the schedule finds them without a read. An instance that keeps its done topics keeps them without that.

## Consequences

The pile goes by itself, within days of the update, and nothing is done by hand; the last sentence of 0031, which told the maintainer to delete the rest himself, holds no more. The pager reads and writes closed records once more than before, within bounds that the tests hold, and only until the sweep is through. A topic that the sweep passed after a day of refusals, such as in a group where the bot lost `can_delete_messages`, stays, and the log names it. Each such topic holds the sweep for that day, since every run stops at it: a few of them cost days of the margin before the oldest links expire. The reports of the runs of the control repository keep no record and never get ✅, so the sweep leaves their topics alone.
