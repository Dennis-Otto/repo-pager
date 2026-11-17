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

Das Thema einer Sache, die erledigt ist, geht in einem solchen Lauf, sobald die Stunden von `DONE_TOPIC_HOURS` um sind, und kostet keine eigene Anfrage: Das Schreiben, das die Sache erledigt, notiert in den Metadaten ihres Eintrags, wann, sodass die Notiz, was fällig ist, die Auflistung nur weckt, wenn ein Thema fällig ist, und jedes gelöschte Thema kostet ein Lesen und ein Schreiben von Workers KV und einen Aufruf von Telegram, höchstens zehn Themen pro Lauf. Ein Druck auf 🗑 Thema löschen ist eine Anfrage an den Worker und an das Durable Object, wie jeder Druck, mit demselben Lesen und Schreiben.

## Ein voller Tag

Am 2026-11-16 liefen in den zehn Repositorys des Maintainers 11.746 Läufe von GitHub Actions, und der Pager von 0.10.1 hat den kostenlosen Plan aufgebraucht, wie an drei weiteren Tagen dieser Woche. Die Arten der Läufe kommen aus einer Stichprobe von 3.957 von ihnen; die anderen Ereignisse sind Schätzungen aus den 99 Pull Requests und 6 Issues, die an dem Tag geöffnet wurden.

| | Vorher | Jetzt |
| --- | --- | --- |
| Zustellungen, Anfragen an den Worker | etwa 160.000 | etwa 13.200 |
| Anfragen an das Durable Object | etwa 160.000 | etwa 7.900 |
| Lesezugriffe auf Workers KV | Tausende, einer pro grünem Job auf `main` | etwa 6.800 |
| Auflistungen von Workers KV | 96 | höchstens 4, solange nichts fällig ist |
| Ereignisse von Workers Logs | etwa 320.000 | keine, solange nichts scheitert, etwa 23.600, sollte jede Zustellung scheitern, die etwas bedeutet |

Das ist unter einem Drittel jedes Limits. Der vollste Tag dieser Woche, 2026-11-13, hatte 36.380 Läufe: etwa 41.000 Anfragen an den Worker, noch unter der Hälfte jedes Limits.

Workers Logs behält ein Ereignis für jede Zeile, die der Worker oder das Durable Object schreibt, und von sich aus eines mehr für jede Anfrage an einen von beiden, ihr Aufruf-Log. Der Pager schreibt nur eine Zeile, wenn etwas scheitert, und `wrangler.jsonc` schaltet die Aufruf-Logs ab, sodass ein Tag, an dem nichts scheitert, gar kein Ereignis schreibt; mit ihnen schrieb der volle Tag etwa 21.100. Sollte jede Zustellung, die etwas bedeutet, den ganzen Tag scheitern, in jedem ihrer drei Versuche, etwa solange GitHub ausfällt, schreibt der Tag etwa 23.600 Ereignisse, unter einem Drittel der 200.000, und bei großzügigen 4 KB pro Ereignis etwa 97 MB, unter einem Drittel der 0,5 GB, die Cloudflare ab 2026-12-01 zählt. Auch am vollsten Tag der Woche bliebe jede Zeile erhalten. `test/costs.test.ts` hält beides fest.

Die meisten dieser Läufe sind Läufe der Workflows des Blueprints, die ein `workflow_run` startet und die ihre Jobs überspringen: Sie kosten je eine Anfrage und nichts weiter. Eine Flotte mit noch mehr Läufen kann die Anfragen an den Worker trotzdem aufbrauchen, denn jeder Lauf ist eine Zustellung; der Plan Workers Paid hat kein Tageslimit für Anfragen.

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

- **Jeden Fehler mit seinem Grund** in den Logs des Workers im Dashboard von Cloudflare, drei Tage lang, ab 2026-12-01 sieben: Die Zeile nennt das Ereignis von GitHub, das Update von Telegram oder den Lauf des Zeitplans, der gescheitert ist, und die Antwort, an der er scheiterte, etwa `A GitHub check_suite failed: GitHub answered 503: unavailable`. Eine Zustellung, die endgültig gescheitert ist, wird ein Eintrag des Alarms des Steuer-Repositorys, wie [So arbeitet er](how-it-works.md#wenn-ein-ereignis-scheitert) beschreibt.
- **Jede Zustellung von GitHub und die Antwort des Pagers darauf** mit ihrem Status in den letzten Zustellungen auf der Seite *Advanced* deiner GitHub App, wo du eine auch erneut zustellen kannst.
- **Die Anfragen, die Fehler und die Zeit des Workers und des Durable Objects** in den Metriken des Workers im Dashboard, die nichts vom Kontingent von Observability verbrauchen.
- **Jede Anfrage live** mit ihrem Aufruf-Log in `npx wrangler tail` oder in der Live-Ansicht der Logs, solange du zusiehst; Cloudflare behält keine davon.

Was du nicht mehr siehst, ist ein gespeicherter Eintrag für jede Anfrage, die gut ging: Für eine vergangene Anfrage, die nicht scheiterte, sind die letzten Zustellungen der App der Nachweis.
