// The pictures of the chat, docs/images/screenshots/chat-*.png, show messages of the
// pager as Telegram shows them, in English and in German. .github/chat.html draws
// them from .github/chat.js, which this test writes from render() of src/render.ts,
// keyboard() of src/buttons.ts, topicName() of src/topics.ts and the answers of
// src/control.ts (noted() and proposalMessage()), so the pictures
// can't keep a word, an emoji or a button that the pager no longer has: a change of
// a text fails here until `npx vitest run test/chat.test.ts --update` writes the
// file anew, and the screenshot bot then renders the pictures anew.
import { describe, expect, it } from "vitest";

import { keyboard } from "../src/buttons.ts";
import { noted, proposalMessage } from "../src/control.ts";
import { render } from "../src/render.ts";
import type { Alarm, Contribution, Item, Release } from "../src/store.ts";
import { REACTIONS } from "../src/telegram.ts";
import { LANGUAGES, type Language, type Texts, texts } from "../src/texts.ts";
import { COLORS, topicName } from "../src/topics.ts";
import { notesKey } from "../src/translations.ts";
import type { Usage } from "../src/usage.ts";
import { base, START } from "./helpers.ts";

/** A message of the pager in the chat: its text, the labels of its buttons and its time. */
interface Message {
  text: string;
  buttons: string[][];
  /** Its time, with Telegram's mark in front once the pager edited it in place. */
  time: string;
}

/** A line of Telegram between messages, such as what a press changed. */
interface Service {
  service: string;
}

/** A text of the maintainer, with its time and the reaction of the pager on it. */
interface Own {
  own: string;
  time: string;
  reaction: string;
}

/**
 * A topic in the list of topics: its name, the color of its icon, the text of its
 * message, whose last line the list shows, as Telegram does, and its time.
 */
interface Row {
  name: string;
  color: string;
  text: string;
  time: string;
}

/** One picture: the head of the chat, and the messages of a topic or the list of topics. */
interface Scene {
  title: string;
  subtitle: string;
  messages?: (Message | Service | Own)[];
  topics?: Row[];
}

/**
 * The words of the pictures that the pager doesn't write: Telegram's own, and the
 * line between two states of one message, which Telegram edits in place.
 */
const TELEGRAM: Record<
  Language,
  { edited: string; bot: string; after: string; later: string }
> = {
  en: {
    edited: "edited",
    bot: "bot",
    after: "The same message, a minute after {button}",
    later: "Twelve minutes after {button}",
  },
  de: {
    edited: "bearbeitet",
    bot: "Bot",
    after: "Dieselbe Nachricht, eine Minute nach {button}",
    later: "Zwölf Minuten nach {button}",
  },
};

/**
 * What the things of the pictures say, which comes from GitHub, in each language,
 * and what the control repository answers: its fix ends with the words and the
 * address of its pull request, as pager/core.mjs of repo-pager-control-template
 * writes them, and its answer to a question in a topic proposes 🔀 Merge.
 */
const SAYS = {
  en: {
    title: "Sync stops when a tag has a slash",
    excerpt:
      "Since 1.6.2 the sync stops at the first document with a tag like Tax/2026. The log says: invalid path.",
    draft:
      "Thanks for the clear report, @sam-lee! A slash in a tag became a folder in the path; the fix is in #318 and comes with 1.7.1.",
    notes: [
      "Tags renamed in Paperless follow in Nextcloud (#305)",
      "A share link for every synced document (#309)",
    ],
    question: "Which release goes first?",
    fix: "🛠 The lock file pinned tar 6.2.0, which Socket Security flags; the fix moves it to 7.4.3 and runs the release again. The pull request: https://github.com/Dennis-Otto/repo-blueprint/pull/482",
    asked: "Does 1.7.0 need anything from those who update from 1.6?",
    answer:
      "No: renamed tags follow by themselves, and the share links come for every document that syncs after the update. Every check is green, so 1.7.0 can go out.",
  },
  de: {
    title: "Sync bricht bei einem Tag mit Schrägstrich ab",
    excerpt:
      "Seit 1.6.2 bricht der Sync beim ersten Dokument mit einem Tag wie Steuer/2026 ab. Im Log steht: invalid path.",
    draft:
      "Danke für den genauen Bericht, @sam-lee! Ein Schrägstrich im Tag wurde zum Ordner im Pfad; der Fix ist in #318 und kommt mit 1.7.1.",
    notes: [
      "In Paperless umbenannte Tags folgen in Nextcloud (#305)",
      "Ein Freigabelink für jedes synchronisierte Dokument (#309)",
    ],
    question: "Welches Release geht zuerst?",
    fix: "🛠 Die Lock-Datei pinnte tar 6.2.0, das Socket Security meldet; der Fix hebt es auf 7.4.3 und startet das Release neu. Der Pull Request: https://github.com/Dennis-Otto/repo-blueprint/pull/482",
    asked: "Braucht 1.7.0 etwas von denen, die von 1.6 aktualisieren?",
    answer:
      "Nein: umbenannte Tags folgen von selbst, und die Freigabelinks kommen für jedes Dokument, das nach dem Update synchronisiert. Alle Checks sind grün, 1.7.0 kann raus.",
  },
} as const;

/**
 * What a run of Claude took, as the footer of an answer shows it, with the model and
 * the effort that pager/core.mjs of the control template sets for each kind of job:
 * a fix that becomes a pull request runs Opus at extra high effort, an answer to a
 * free text Sonnet at high effort.
 */
const FIX_USAGE: Usage = {
  turns: 31,
  seconds: 694,
  effort: "xhigh",
  models: [{ model: "claude-opus-5-5", tokens: 412_000 }],
};
const ANSWER_USAGE: Usage = {
  turns: 6,
  seconds: 74,
  effort: "high",
  models: [{ model: "claude-sonnet-5-5", tokens: 58_000 }],
};

/** An alarm of main: a release that failed in a run, which 🔁 Rerun runs again, and a required check. */
function alarm(t: Texts): Alarm {
  return {
    ...base("alarm"),
    repo: "Dennis-Otto/repo-blueprint",
    kind: "alarm",
    state: "open",
    entries: [
      {
        key: "workflow:.github/workflows/release.yml",
        label: t("entry.release", { name: "Release" }),
        url: "https://github.com/Dennis-Otto/repo-blueprint/actions/runs/4711",
        run: 4711,
      },
      {
        key: "check:Socket Security",
        label: t("entry.check", { name: "Socket Security", branch: "main" }),
        url: "https://github.com/Dennis-Otto/repo-blueprint/runs/815",
      },
    ],
  };
}

/** An issue of someone else, as it comes and once its draft came. */
function contribution(language: Language): Contribution {
  const says = SAYS[language];
  return {
    ...base("contribution"),
    repo: "Dennis-Otto/paperless-sync",
    kind: "contribution",
    state: "new",
    number: 316,
    pull: false,
    title: says.title,
    url: "https://github.com/Dennis-Otto/paperless-sync/issues/316",
    author: "sam-lee",
    excerpt: says.excerpt,
    draft: null,
    draftVersion: 0,
  };
}

/** A release pull request whose checks are green, with its notes in the language of the pager. */
function release(language: Language): Release {
  const notes = {
    lines: [
      { heading: "Features" },
      { item: SAYS.en.notes[0] },
      { item: SAYS.en.notes[1] },
    ],
    more: 0,
    breaking: false,
  };
  return {
    ...base("release"),
    repo: "Dennis-Otto/paperless-sync",
    kind: "release",
    state: "ready",
    number: 312,
    version: "1.7.0",
    sha: "4f1c2ab",
    url: "https://github.com/Dennis-Otto/paperless-sync/pull/312",
    notes,
    ...(language === "en"
      ? {}
      : {
          translation: {
            of: notesKey(notes),
            language,
            lines: [...SAYS[language].notes],
          },
        }),
  };
}

/** The text of a message as the chat shows it: the HTML of Telegram, without the addresses of its links. */
function shown(item: Item, t: Texts): string {
  return render(item, START, t).replace(/<a href="[^"]*">/g, "<a>");
}

/** A message as the chat shows it, with its buttons. */
function message(item: Item, t: Texts, time: string): Message {
  return {
    text: shown(item, t),
    buttons: keyboard(item, t).map((row) => row.map((button) => button.text)),
    time,
  };
}

/** The things of the list of topics, newest first, each with its time. */
function topics(language: Language, t: Texts): [Item, string][] {
  return [
    [alarm(t), "10:42"],
    [release(language), "09:15"],
    [contribution(language), "08:31"],
    [
      {
        ...base("decision"),
        kind: "decision",
        state: "open",
        ask: "night-run",
        question: SAYS[language].question,
        options: ["paperless-sync 1.7.0", "issue-assistant 2.3.0"],
        choice: null,
      },
      "08:05",
    ],
    [
      {
        ...base("workflow"),
        repo: "Dennis-Otto/issue-assistant",
        kind: "workflow",
        state: "recovered",
        path: ".github/workflows/links.yml",
        name: "Links",
        branch: "main",
        run: 912,
        attempt: 2,
        url: "https://github.com/Dennis-Otto/issue-assistant/actions/runs/912",
        jobs: [],
        count: 2,
        since: START - 3 * 3600000,
        last: START - 3600000,
      },
      "07:58",
    ],
  ];
}

/** A text of the maintainer that the pager answered. */
function own(text: string, time: string): Own {
  return { own: text, time, reaction: REACTIONS.answered };
}

/**
 * The answer of the control repository to a question in the topic of a release:
 * a message of its own with the one ✅ Confirm button that merges it.
 */
function answer(language: Language, t: Texts, time: string): Message {
  const shipped = release(language);
  const { text, keyboard: buttons } = proposalMessage(
    {
      text: SAYS[language].answer,
      action: "merge",
      target: { kind: "release", repo: shipped.repo },
      usage: ANSWER_USAGE,
    },
    shipped,
    t,
  );
  return {
    text: text.replace(/<a href="[^"]*">/g, "<a>"),
    buttons: buttons.map((row) => row.map((button) => button.text)),
    time,
  };
}

/** Every picture in one language. */
function scenes(language: Language): Record<string, Scene> {
  const t = texts(language);
  const words = TELEGRAM[language];
  // The alarm once its fix answered: a new message in its topic, with the note of
  // the fix and its pull request, which notifies.
  const fixed: Alarm = {
    ...alarm(t),
    state: "fixing",
    note: noted(SAYS[language].fix, FIX_USAGE, t),
  };
  const asked = contribution(language);
  const drafted: Contribution = {
    ...asked,
    state: "draft",
    draft: SAYS[language].draft,
    draftVersion: 1,
  };
  return {
    alarm: {
      title: topicName(alarm(t), t),
      subtitle: "Repo Pager",
      messages: [message(alarm(t), t, "10:42")],
    },
    contribution: {
      title: topicName(asked, t),
      subtitle: "Repo Pager",
      messages: [
        message(asked, t, "08:31"),
        { service: words.after.replace("{button}", t("button.draft")) },
        message(drafted, t, `${words.edited} 08:31`),
      ],
    },
    fix: {
      title: topicName(alarm(t), t),
      subtitle: "Repo Pager",
      messages: [
        message(alarm(t), t, "10:42"),
        { service: words.later.replace("{button}", t("button.fix")) },
        message(fixed, t, "10:54"),
      ],
    },
    release: {
      title: topicName(release(language), t),
      subtitle: "Repo Pager",
      messages: [message(release(language), t, "09:15")],
    },
    answer: {
      title: topicName(release(language), t),
      subtitle: "Repo Pager",
      messages: [
        message(release(language), t, "09:15"),
        own(SAYS[language].asked, "09:20"),
        answer(language, t, "09:21"),
      ],
    },
    topics: {
      title: "Repo Pager",
      subtitle: words.bot,
      topics: topics(language, t).map(([item, time]) => ({
        name: topicName(item, t),
        color: `#${COLORS[item.kind].toString(16).padStart(6, "0")}`,
        text: shown(item, t),
        time,
      })),
    },
  };
}

describe("the pictures of the chat", () => {
  it("show each message as the pager writes it", async () => {
    const chat = Object.fromEntries(
      LANGUAGES.map((language) => [language, scenes(language)]),
    );
    await expect(
      `// Written by test/chat.test.ts from the texts of the pager; .github/chat.html draws it.\nwindow.CHAT = ${JSON.stringify(chat, null, 2)};\n`,
    ).toMatchFileSnapshot("../.github/chat.js");
  });

  it("show the buttons that the README and the website talk about", () => {
    // The alarm acts with 🔁 Rerun and 🛠 Start fix, and its fix comes back with
    // its pull request; the contribution goes from ✍️ Draft a reply to ✅ Send, the
    // release offers 🔀 Merge, and an answer in its topic offers it with one
    // ✅ Confirm, in each language.
    for (const language of LANGUAGES) {
      const t = texts(language);
      const shown = scenes(language);
      const labels = (name: string) =>
        (shown[name]?.messages ?? []).map((data) =>
          "buttons" in data ? data.buttons.flat() : [],
        );
      expect(labels("alarm")).toEqual([
        expect.arrayContaining([t("button.rerun"), t("button.fix")]),
      ]);
      expect(labels("contribution")).toEqual([
        expect.arrayContaining([t("button.draft")]),
        [],
        expect.arrayContaining([t("button.send")]),
      ]);
      expect(labels("release")).toEqual([
        expect.arrayContaining([t("button.merge")]),
      ]);
      expect(labels("fix")).toEqual([
        expect.arrayContaining([t("button.fix")]),
        [],
        expect.not.arrayContaining([t("button.fix")]),
      ]);
      expect(JSON.stringify(shown.fix?.messages?.[2])).toContain(
        "https://github.com/Dennis-Otto/repo-blueprint/pull/482",
      );
      expect(labels("answer")).toEqual([
        expect.arrayContaining([t("button.merge")]),
        [],
        [t("button.confirm")],
      ]);
      expect(shown.topics?.topics?.map((row) => row.name)).toContain(
        topicName(alarm(t), t),
      );
    }
  });
});
