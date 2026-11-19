# Kosten

Der Pager läuft im kostenlosen Plan von Cloudflare, dessen Limits pro Tag zählen und um 00:00 UTC zurückgesetzt werden. Diese Seite sagt, was jedes Limit ist, was jede Art von Ereignis kostet und wie weit ein voller Tag einer echten Flotte von Repositorys unter ihnen bleibt. `test/costs.test.ts` misst jede Zahl hier durch den Worker, wie Cloudflare ihn ausführt, und schlägt fehl, wenn eine Änderung eine Art von Ereignis teurer macht oder der Tag nicht mehr passt.

## Die Limits des kostenlosen Plans

| Limit | Pro Tag | Quelle |
| --- | --- | --- |
| Anfragen an den Worker | 100.000 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Anfragen an das Durable Object | 100.000 | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Laufzeit des Durable Objects | 13.000 GB-s | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Zeilen, die der Speicher des Durable Objects schreibt | 100.000 | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Lesezugriffe auf Workers KV | 100.000 | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Schreibzugriffe auf Workers KV | 1.000 | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Löschungen in Workers KV | 1.000 | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Auflistungen von Workers KV | 1.000 | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Ereignisse von Workers Logs | 200.000 | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Aufnahme von Observability, die Ereignisse von Workers Logs und die Traces zusammen, ab 2026-12-01 | 0,5 GB | [Observability pricing](https://developers.cloudflare.com/observability/pricing/) |

Jedes Ereignis, das GitHub zustellt, jedes Update von Telegram und jeder Lauf des Zeitplans ist eine Anfrage an den Worker. Über diesem Limit beantwortet Cloudflare jede Anfrage mit seinem Fehler 1027, bevor der Worker läuft, was der tägliche *Health*-Check des Steuer-Repositorys als 429 sieht. Über jedem anderen Limit scheitert der Zugriff im Worker: Der Pager sagt es dir dann einmal an diesem Tag in Telegram, soweit er noch kann, und seine Antwort an den Health-Check trägt das Limit in ihrem Feld `limit` (`src/limits.ts`). Ein Ereignis, das gescheitert ist, kommt mit dem Zeitplan erneut, sobald das Limit zurückgesetzt ist, wie [So arbeitet er](how-it-works.md#wenn-ein-ereignis-scheitert) beschreibt.

## Was jede Art von Ereignis kostet

Der Worker prüft die Signatur einer Zustellung und liest die Regeln selbst, sodass ein Ereignis, das nichts bedeutet, nur seine Anfrage kostet. Nur ein Ereignis, das etwas bedeutet, geht weiter an das eine Durable Object, das Workers KV liest und schreibt.

| Zustellung | Worker | Durable Object | KV lesen | KV schreiben |
| --- | --- | --- | --- | --- |
| Ein Lauf auf `main` ist grün, während sein Workflow nirgends scheitert | 1 | 1 | 1 | 0 |
| Ein Lauf auf `main` wurde abgebrochen | 1 | 1 | 1 | 0 |
| Ein Lauf auf `main` hat seine Jobs übersprungen | 1 | 0 | 0 | 0 |
| Ein Lauf auf `main` ist gescheitert und wartet auf seinen Neustart | 1 | 1 | 1 | 1 |
| Ein Lauf ist auf einem Pull Request an seinem Head grün, womöglich sein Visual Check | 1 | 1 | 0 | 0 |
| Ein Lauf eines Pull Requests, der scheiterte | 1 | 0 | 0 | 0 |
| Ein Lauf eines Tags oder eines Branches ohne Pull Request, der scheiterte oder grün wurde, etwa die Prüfung eines Releases | 1 | 1 | 2 | 0 |
| Ein Lauf eines Releases, das noch nicht gemergt werden kann | 1 | 1 | 0 | 0 |
| Ein Pull Request oder ein Kommentar des Maintainers oder eines Bots | 1 | 0 | 0 | 0 |
| Eine Zustellung von *Workflow run* oder *Check run*, von einer App, die sie noch hat | 1 | 0 | 0 | 0 |

Ein Lauf kommt als Ende seiner Check-Suite: Dieses Ereignis sendet GitHub einmal pro Lauf, wo *Workflow run* dreimal pro Lauf kommt und *Check run* zweimal für jeden Job, etwa 14 Zustellungen pro Lauf mit fünf Jobs. Der Pager liest den Lauf einer Suite, die etwas bedeuten kann, mit einem Aufruf von GitHub, der nichts von den Limits von Cloudflare kostet. Ein Fehlschlag, der sich zeigt, nachdem sein Neustart nicht half, schreibt seine Sache und die Verknüpfung seines Themas, zwei Schreibzugriffe. Gelesen wird auch ein Lauf eines Tags oder eines Branches ohne Pull Request, denn dort läuft ein Workflow eines Releases, etwa die Prüfung eines Releases, das von Hand veröffentlicht wurde; eine Flotte, deren Checks auf Pull Requests laufen, hat davon wenige.

Ohne *Check run* sieht der Pager einen scheiternden Check einer anderen App als GitHub Actions auf `main` nicht mehr, etwa eines externen CI: Die Läufe von GitHub Actions rufen über ihre Check-Suites, die Checks anderer Apps nicht. Hake *Check run* an, wenn dich ein solcher Check rufen soll; es kostet zwei Anfragen an den Worker pro Job jedes Laufs.

Ein Lauf des Zeitplans, alle 15 Minuten, ist eine Anfrage an den Worker und an das Durable Object und schreibt zwei Zeilen seines Speichers, seine Zeit und was er von den Zustellungen gelesen hat. Er liest nichts von Workers KV, solange nichts fällig ist: Eine Notiz im Speicher des Durable Objects hält fest, wann das Nächste fällig ist, eine Sache, die ⏰ Später zurückgestellt hat, oder ein Text, der auf seine Antwort wartet, und der Lauf listet die Einträge nur dann auf, und alle sechs Stunden trotzdem.

Das Thema einer Sache, die erledigt ist, geht in einem solchen Lauf, sobald die Stunden von `DONE_TOPIC_HOURS` um sind, und kostet keine eigene Anfrage: Das Schreiben, das die Sache erledigt, notiert in den Metadaten ihres Eintrags, wann, sodass die Notiz, was fällig ist, die Auflistung nur weckt, wenn ein Thema fällig ist, und jedes gelöschte Thema kostet ein Lesen und ein Schreiben von Workers KV und einen Aufruf von Telegram, höchstens zehn Sachen pro Lauf; ein Thema einer Version vor einem Release kostet einen Aufruf mehr und teilt das Schreiben des Release. Ein Druck auf 🗑 Thema löschen ist eine Anfrage an den Worker und an das Durable Object, wie jeder Druck, mit demselben Lesen und Schreiben.

Ein Bericht eines Laufs in seinem Thema kommt mit 🗑 Thema löschen und einem kleinen Eintrag ([Entscheidung 0035](decisions/0035-the-topic-of-a-report-goes-like-the-topic-of-a-done-thing.md)):

- **Sein Versand** ist eine Anfrage an den Worker und an das Durable Object, mit dem Lesen der Pause neuer Themen, einem Schreiben seines Eintrags und den Aufrufen von Telegram `getMe`, `createForumTopic` und `sendMessage`. Wo `DONE_TOPIC_HOURS` gesetzt ist, schreibt er eine Zeile im Speicher des Durable Objects, für die Notiz, was fällig ist.
- **In der Hauptansicht** kostet er, was er vorher kostete: nichts von Workers KV in einem Chat ohne Themen.
- **Sein Thema geht** in einem Lauf, den schlimmstenfalls er allein weckt, mit einer Auflistung, dem Lesen der Texte, die warten, und seines Eintrags, einem Löschen von Workers KV statt eines Schreibens, da ein Bericht sich nie wieder öffnet, und einem `deleteForumTopic`. Der Lauf danach listet noch einmal auf und liest die Texte, die warten, wie nach dem Thema jeder erledigten Sache, und jeder der beiden schreibt eine Zeile der Notiz.
- **Ein Druck auf 🗑** kostet ein Lesen, ein Löschen und die Aufrufe `deleteForumTopic` und `answerCallbackQuery`.

Ein Hinweis unter der Nachricht einer Sache, etwa *🚨 Neu in diesem Alarm* oder ein neuer Kommentar, antwortet auf diese Nachricht und trägt ⬇️ Zeigen ([Entscheidung 0034](decisions/0034-a-notice-answers-its-thing-and-brings-its-message-back-with-a-button.md)) und kostet dafür nichts mehr: dasselbe eine `sendMessage`, ohne Lesen, Schreiben oder Auflisten von Workers KV und ohne eigene Anfrage. Ein Druck auf ⬇️ Zeigen ist eine Anfrage an den Worker und an das Durable Object, wie jeder Druck, mit einem Lesen und einem Schreiben von Workers KV und den Aufrufen von Telegram `answerCallbackQuery`, `sendMessage`, `deleteMessage` und `editMessageReplyMarkup` für den Hinweis; ein abgelehnter Druck, auf eine erledigte Sache, kostet ein Lesen und kein Schreiben. Löscht Telegram die alte Nachricht nicht mehr, wie eine, die älter als 48 Stunden ist, nimmt ein `editMessageText` ihr die Knöpfe, bei jeder neuen Nachricht einer Sache, und eine Sache, die ein Thema verlässt, das Telegram nicht findet, benennt es mit einem `editForumTopic` um, ohne Lesen oder Schreiben. Nichts am vollen Tag unten drückt einen Knopf oder verlässt ein Thema, also kostet er, was er kostete.

## Ein voller Tag

Am 2026-11-16 liefen in den zehn Repositorys des Maintainers 11.746 Läufe von GitHub Actions, und der Pager von 0.10.1 hat den kostenlosen Plan aufgebraucht, wie an drei weiteren Tagen dieser Woche. Die Arten der Läufe kommen aus einer Stichprobe von 3.957 von ihnen; die anderen Ereignisse sind Schätzungen aus den 99 Pull Requests und 6 Issues, die an dem Tag geöffnet wurden.

| | Vorher | Jetzt |
| --- | --- | --- |
| Zustellungen, Anfragen an den Worker | etwa 160.000 | etwa 13.200 |
| Anfragen an das Durable Object | etwa 160.000 | etwa 7.900 |
| Lesezugriffe auf Workers KV | Tausende, einer pro grünem Job auf `main` | etwa 6.800 |
| Auflistungen von Workers KV | 96 | höchstens 24: 4, solange nichts fällig ist, und zwei für jeden von zehn Berichten von Läufen, deren Thema geht |
| Ereignisse von Workers Logs | etwa 320.000 | keine, solange nichts scheitert, etwa 23.600, sollte jede Zustellung scheitern, die etwas bedeutet |

Der Tag nimmt zehn Berichte von Läufen, jeden in seinem Thema, das in einem eigenen Lauf des Zeitplans geht: Mit ihnen schreibt er 28-mal in Workers KV, löscht 10 Einträge und schreibt 222 Zeilen im Speicher des Durable Objects. Die Schreibvorgänge sind das engste Limit: Jeder Bericht ist ein Schreiben, also lässt ein Tag des Durchgangs durch die alten Themen unten Platz für etwa 27 Berichte, und ein Tag ohne ihn für etwa 300. Das ist unter einem Drittel jedes Limits. Der vollste Tag dieser Woche, 2026-11-13, hatte 36.380 Läufe: etwa 41.000 Anfragen an den Worker, noch unter der Hälfte jedes Limits.

Workers Logs behält ein Ereignis für jede Zeile, die der Worker oder das Durable Object schreibt, und von sich aus eines mehr für jede Anfrage an einen von beiden, ihr Aufruf-Log. Der Pager schreibt nur eine Zeile, wenn etwas scheitert, und `wrangler.jsonc` schaltet die Aufruf-Logs ab, sodass ein Tag, an dem nichts scheitert, gar kein Ereignis schreibt; mit ihnen schrieb der volle Tag etwa 21.100. Sollte jede Zustellung, die etwas bedeutet, den ganzen Tag scheitern, in jedem ihrer drei Versuche, etwa solange GitHub ausfällt, schreibt der Tag etwa 23.600 Ereignisse, unter einem Drittel der 200.000, und bei 4 KB pro Ereignis etwa 97 MB, unter einem Drittel der 0,5 GB, die Cloudflare ab 2026-12-01 zählt. Auch am vollsten Tag der Woche bliebe jede Zeile erhalten. `test/costs.test.ts` hält beides fest.

Die 4 KB sind etwa das, was ein Ereignis brauchte, solange die Aufruf-Logs an waren: Für den 2026-11-16, den Tag, der die 200.000 Ereignisse aufbrauchte, zeigt die Nutzungsseite von Cloudflare Observability etwa 0,74 GB, also 3,7 bis 4 KB pro Ereignis. Was eine Zeile des Pagers braucht, ist nicht gemessen: Die zwei Tage nach der Änderung zeigen 0,00 GB. Ein Ereignis müsste 7 KB brauchen, um jenes Drittel zu überschreiten, und 21 KB für das ganze Kontingent.

Die meisten dieser Läufe sind Läufe der Workflows des Blueprints, die ein `workflow_run` startet und die ihre Jobs überspringen: Sie kosten je eine Anfrage und nichts weiter. Eine Flotte mit noch mehr Läufen kann die Anfragen an den Worker trotzdem aufbrauchen, denn jeder Lauf ist eine Zustellung; der Plan Workers Paid hat kein Tageslimit für Anfragen.

## Der Durchgang durch die alten Themen

Die Themen, die vor 0.11.0 erledigt waren, gehen einmal, mit einem Durchgang des Zeitplans durch die Verknüpfungen der Themen ([So arbeitet er](how-it-works.md#ein-thema-pro-sache)). Er kostet nur, was vom Tag übrig ist, als letzter Schritt jedes Laufs, in Grenzen, die `test/costs.test.ts` zusammen mit dem vollen Tag oben unter einem Drittel jedes Limits hält:

| Jeder Lauf, höchstens | Ein Tag, höchstens | Mit dem vollen Tag |
| --- | --- | --- |
| 1 Auflistung von 20 Verknüpfungen | 96 Auflistungen | 120 von 1.000 Auflistungen |
| 40 Lesevorgänge, die Sache jeder Verknüpfung und ihr Eintrag | 3.840 Lesevorgänge | 10.655 von 100.000 Lesevorgängen |
| 3 Schreibvorgänge, einer für jede Sache, deren Thema ging | 288 Schreibvorgänge | 316 von 1.000 Schreibvorgängen |
| 10 Aufrufe von `deleteForumTopic` bei Telegram | 960 Löschungen | kein Limit von Cloudflare |
| 1 Zeile im Speicher des Durable Objects, wo er steht | 96 Zeilen | 318 von 100.000 Zeilen |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/diagrams/the-sweep-of-the-old-topics.de.dark.svg">
  <img src="images/diagrams/the-sweep-of-the-old-topics.de.svg" alt="Der Durchgang durch die alten Themen: Auf einer Instanz, die DONE_TOPIC_HOURS setzt, notiert der erste Lauf des Zeitplans der neuen Version, wann er lief, und der Durchgang beginnt die Stunden der Instanz später. Jeder Lauf des Zeitplans nimmt als letzten Schritt eine Seite von 20 Verknüpfungen von Themen, höchstens zehn Löschungen und drei Schreibvorgänge. Es zählt eine Verknüpfung, die vor dem ersten Lauf erledigt war; jede andere bleibt. Der Eintrag ihrer Sache entscheidet. Eine erledigte Sache, die das Thema nennt und keine Markierung hat, verliert ihr Thema wie nach einem Druck auf Thema löschen, mit einem Schreiben. Eine Sache, die weg ist oder ein anderes Thema nennt, etwa ein Release, das weiterging, verliert nichts, und ihr altes Thema geht ohne Schreiben. Eine offene Sache und eine Sache mit ihrer Markierung bleiben. Eine Ablehnung von Telegram beendet den Lauf, und nach einem Tag geht der Durchgang an diesem Thema vorbei. Sobald die Liste durch ist, oder 30 Tage nach dem ersten Lauf, endet der Durchgang und kostet nichts mehr.">
</picture>

Er kostet keine eigene Anfrage und kein Löschen. Ein Thema einer Sache, die weg ist, oder eines Releases, das weiterging, kostet kein Schreiben, also entscheiden die Schreibvorgänge, wie schnell er geht: 288 Sachen am Tag, etwa 2.900 in zehn Tagen, und die Verknüpfungen der Themen, 1.920 am Tag. Die Verknüpfungen, die er sucht, verfallen 30 Tage, nachdem ihr Thema erledigt war, ab dem 2026-12-04 für die ältesten der Instanz des Maintainers, darum musste der Durchgang vorher kommen; sobald die Liste durch ist, oder 30 Tage nach dem ersten Lauf der Version, endet er, und ein Lauf kostet wieder, was er ohne ihn kostete, keinen Vorgang von Workers KV, solange nichts fällig ist.

## Workers Logs

Cloudflare zählt jedes Ereignis von Workers Logs gegen ein Tageskontingent, und sobald es aufgebraucht ist, nimmt es keine Ereignisse mehr an, bis das Kontingent um 00:00 UTC zurückgesetzt wird: Gerade die Zeilen, die sagen, warum etwas gescheitert ist, gingen verloren. Darum behält der Pager nur diese, und alle davon. Der Block `observability` in `wrangler.jsonc` sagt es so, und `test/costs.test.ts` schlägt fehl, wenn er es nicht mehr tut:

| Einstellung | Wert | Was sie tut |
| --- | --- | --- |
| `enabled` | `true` | Workers Logs behält die Logs des Workers. |
| `head_sampling_rate` | `1` | Jede Anfrage behält ihre Zeilen, keine fällt zufällig weg: Ein Fehler ist nie der, den eine Stichprobe verworfen hat. |
| `logs.invocation_logs` | `false` | Kein Ereignis für jede Anfrage an den Worker und jeden Aufruf des Durable Objects, nur die Zeilen, die der Pager schreibt. |
| `traces.enabled` | `false` | Keine Traces, deren Spans gegen dasselbe Kontingent von Observability zählen. |

Die Einstellungen sind die von [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) und der [Konfiguration von Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/#observability). Eine kleinere `head_sampling_rate` spart auch Ereignisse, verwirft aber ganze Anfragen nach Zufall und Fehler mit ihnen, darum nutzt der Pager sie nicht.

### Was du weiterhin siehst

- **Jeden Fehler mit seinem Grund** in den Logs des Workers im Dashboard von Cloudflare, drei Tage lang, ab 2026-12-01 sieben: Die Zeile nennt das Ereignis von GitHub, das Update von Telegram oder den Lauf des Zeitplans, der gescheitert ist, und die Antwort, an der er scheiterte, etwa `A GitHub check_suite failed: GitHub answered 503: unavailable`. Eine Zustellung, die endgültig gescheitert ist, wird ein Eintrag des Alarms des Steuer-Repositorys, wie [So arbeitet er](how-it-works.md#wenn-ein-ereignis-scheitert) beschreibt. Ohne das Log jedes Aufrufs hinterließe eine Ausnahme, die kein Handler fängt, keine Spur, darum fängt der Worker jede, die eine Anfrage oder der Zeitplan auslösen kann, und loggt sie als eine solche Zeile, etwa `A request to /telegram failed: the daily limit of the free plan of Cloudflare: objects`.
- **Jede Zustellung von GitHub und die Antwort des Pagers darauf** mit ihrem Status in den letzten Zustellungen auf der Seite *Advanced* deiner GitHub App, wo du eine auch erneut zustellen kannst.
- **Die Anfragen, die Fehler und die Zeit des Workers und des Durable Objects** in den Metriken des Workers im Dashboard, die nichts vom Kontingent von Observability verbrauchen.
- **Jede Anfrage live** mit ihrem Aufruf-Log in `npx wrangler tail` oder in der Live-Ansicht der Logs, solange du zusiehst; Cloudflare behält keine davon.

Was du nicht mehr siehst, ist ein gespeicherter Eintrag für jede Anfrage, die gut ging: Für eine vergangene Anfrage, die nicht scheiterte, sind die letzten Zustellungen der App der Nachweis.
