# The topic of a report goes like the topic of a done thing

- Status: accepted, amends [0031](0031-a-done-topic-goes-with-a-button-and-after-the-hours-of-the-instance.md) and [0033](0033-the-topics-done-before-a-version-go-once-by-their-links.md)
- Date: 2026-11-18

## Context

A run of the maintainer's own agents sends its report through the control repository with `pager-report`, and the pager opens a topic for each, *🧾 Run: …* or *🧾 Run*. That topic stayed until the maintainer deleted it by hand. Since [0031](0031-a-done-topic-goes-with-a-button-and-after-the-hours-of-the-instance.md), the topic of a done thing goes with 🗑 Delete topic, and after `DONE_TOPIC_HOURS` by itself; a report got neither, and after a few nights the list of topics filled up with 🧾 again. A report kept nothing in the store, so the button had no record to act on and the schedule no mark to find, and [0033](0033-the-topics-done-before-a-version-go-once-by-their-links.md) left report topics out of its sweep for the same reason.

The press of a button and the schedule work on any record of a thing: the press reads the record by the id in the button, and the schedule finds what is due by the mark `done` in the metadata of the list of the records. Lists are the scarcest operation of Workers KV, with 1,000 a day, and writes the tightest limit of the busy day: with the day of the sweep, 306 of the third of 1,000.

## Options

1. **Keep a report without a record,** as before: its topic stays until it is deleted by hand.
2. **A record under a prefix of its own,** such as `report:<thread>`: the schedule would need a list of its own for it in each run that looks.
3. **A record of a kind of its own, `report`, among the things,** done from the start: the press and the schedule take it as they take any done thing, with no new route, prefix or list.

## Decision

Option 3, which the maintainer chose (*Knopf + nach 24 h weg*).

- **The record** holds the id, `kind: "report"`, `state: "done"`, the control repository as its repository, the id of its message, its topic and `doneAt`, the moment it came. It holds none of the text of the report; the title is in it only as part of the name of its topic, which Telegram shows anyway, and it reaches no log. It writes no link `topic:<thread>`, so a text in its topic goes to the control repository as a conversation of its own, as before, and `/open` never lists it: its record expires as every closed one does, so the list skips it without a read. It never acts on GitHub, so it needs no installation of the app, and a report works without the app on the control repository, as before.
- **Its id comes from a random value,** `keys.report()` of `crypto.randomUUID()`: the button names the record before the message goes, and the thread of its topic is known only after it.
- **Its message carries 🗑 Delete topic and nothing else.** The record is written once, after the message went. If that write fails, the report is in the chat all the same: the pager logs one line without the text or the title and answers `reported`, so that nothing sends the report a second time; the button then answers *This thing is gone.*, and the topic stays for the maintainer.
- **In the main view,** in a chat without topics, during a pause of new topics or when Telegram refuses the topic, the report goes without a button and keeps no record, as before: there is no topic to delete.
- **Its name never gets ✅,** since it is done from the start: the name stays as its topic was opened, and no rename is spent on it.
- **Its topic goes as the topic of a done thing does,** by the press or by the schedule after `DONE_TOPIC_HOURS`, `0` within 15 minutes, with a day of tries when Telegram refuses, after which it stays with its 🗑. A report never opens again, so the clearing deletes its record, one delete of Workers KV in place of the write that keeps a done thing as cleared. The thing in memory still ends as cleared, so that a press doesn't try to edit a message that went with its topic.

## Consequences

The topics of reports no longer pile up: each goes with its button or after the hours of the instance. A report in a topic costs one write of Workers KV more than before, and on an instance with `DONE_TOPIC_HOURS` one row of the storage of the Durable Object; its topic goes in a run of the schedule with one list, two reads, one delete and one call of Telegram, and the next run lists once more, as after any done topic. The busy day of `test/costs.test.ts` takes ten reports, which leaves it below a third of each limit, also with the day of the sweep: 316 of 1,000 writes. Writes stay the limit that reports reach first, with room for about 27 a day beside the sweep and about 300 without it.

The topics of the reports that came before this version have no record, and Telegram lists no topics of a chat: neither the schedule nor the sweep of [0033](0033-the-topics-done-before-a-version-go-once-by-their-links.md) can find them, and the maintainer deletes them by hand once. A pager rolled back to an older version would read a record of the kind `report` that it doesn't know; such a record expires within 30 days.
