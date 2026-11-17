# A done topic goes with a button, and after the hours of the instance

- Status: accepted, amends [0005](0005-one-topic-per-thing-kept-when-done.md)
- Date: 2026-11-17

## Context

[Decision 0005](0005-one-topic-per-thing-kept-when-done.md) kept the topic of a thing once it was done, with ✅ in front of its name, as its history, and left its deletion to the maintainer by hand. After a busy day, the list of topics was mostly ✅: a release that was published, an alarm that was green again, a workflow that failed on `main` and passed since, and the few topics that still needed the maintainer were somewhere between them. The maintainer asked to see only what is open in the pager, and for a button under each thing that is done which deletes its topic with every message.

Telegram's `deleteForumTopic` deletes a topic together with all its messages, in a private chat with topics as in a group, at any age, unlike `deleteMessage`, which deletes nothing older than 48 hours. In a private chat, the bot needs no right for a topic that it opened itself; in a group, it needs `can_delete_messages`. The Bot API says nothing of a client that shows the topic when it goes; the topic is gone for every client, and a press on a button of its last message is a press like any other.

## Options

1. **Keep every done topic,** as before. The history stays, and the chat fills with what is over.
2. **Delete every done topic at once,** when its thing is done. The list holds only what is open, but a release that was published, which never needed the maintainer, goes before he read it, and a thing that is done by mistake takes its history along.
3. **A button 🗑 Delete topic under every done thing,** which deletes its topic with every message at one press, **and a time per instance,** `DONE_TOPIC_HOURS`, after which the schedule deletes the topics of done things by itself: `0` with the next run of the schedule, a number after so many hours, empty to keep them as before.

## Decision

Option 3. Every thing that is done in a topic of its own offers 🗑 Delete topic: a closed thing, a release that is merged, and an ignored thing beside ↩️ Bring back. A press costs one call to Telegram and one write: the thing forgets its topic and its message and is marked as cleared, so that it shows nothing more while it stays done, and opens a new topic when it opens again, as a contribution with a new comment does. A topic that is gone already, such as one that the maintainer deleted by hand, is forgotten the same way; a refusal of Telegram, such as a 429 that asks to wait long, leaves the thing and says so in the answer of the press.

The record of a thing that is done in its topic notes when, as a mark in its metadata, written with the write that makes it done, so that the list of the schedule finds the topics that are due without a read of each record, and the note of what is due (`src/due.ts`) wakes the schedule only when one is. The schedule deletes at most ten per run, while its calls last; a topic that Telegram refuses to delete is tried again with each run for a day, and then stays. No topic of a thing that still needs something goes: a thing that opens again before its time loses the mark.

**An ignored thing goes after the same time.** ✖ Ignore is the maintainer's word that the thing needs nothing, so `/open` doesn't list it and its topic is no more open than a done one. Its ↩️ Bring back keeps the time of the instance to catch a press that slipped; once the topic went, the thing stays ignored, as ✖ Ignore meant, and its record expires after 30 days, as that of every closed thing. Keeping the topics of ignored things for good would have kept the very pile that the maintainer asked to be rid of.

The maintainer's own instance sets 24 hours: a topic of a thing that is done stays for a day, long enough to read it, and nothing piles up.

## Consequences

The list of topics shows what is open and what was done within the hours of the instance. The history of a done thing is on GitHub, which every message links to; the pager keeps the record of a closed thing for 30 days as before, so a thing that opens again within them comes back with its state. Each deleted topic costs one read and one write of Workers KV and one call to Telegram, in a run of the schedule that lists anyway or that its note wakes, and no request of its own, as `test/costs.test.ts` checks. Topics that were done before this version have no mark: their buttons come with their next change, and the maintainer deletes the rest by hand once.
