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

## Ein voller Tag

Am 2026-11-16 liefen in den zehn Repositorys des Maintainers 11.746 Läufe von GitHub Actions, und der Pager von 0.10.1 hat den kostenlosen Plan aufgebraucht, wie an drei weiteren Tagen dieser Woche. Die Arten der Läufe kommen aus einer Stichprobe von 3.957 von ihnen; die anderen Ereignisse sind Schätzungen aus den 99 Pull Requests und 6 Issues, die an dem Tag geöffnet wurden.

| | Vorher | Jetzt |
| --- | --- | --- |
| Zustellungen, Anfragen an den Worker | etwa 160.000 | etwa 13.200 |
| Anfragen an das Durable Object | etwa 160.000 | etwa 7.900 |
| Lesezugriffe auf Workers KV | Tausende, einer pro grünem Job auf `main` | etwa 6.800 |
| Auflistungen von Workers KV | 96 | höchstens 4, solange nichts fällig ist |
| Ereignisse von Workers Logs | etwa 320.000 | etwa 21.100 |

Das ist unter einem Drittel jedes Limits. Der vollste Tag dieser Woche, 2026-11-13, hatte 36.380 Läufe: etwa 41.000 Anfragen an den Worker, noch unter der Hälfte jedes Limits.

Workers Logs behält ein Ereignis für jede Anfrage an den Worker und an das Durable Object und eines für jede Zeile, die einer von beiden schreibt; der Pager schreibt nur eine Zeile, wenn etwas scheitert. Die Logs bleiben vollständig (`observability` in `wrangler.jsonc`, ohne Stichprobe): Sie sagen, warum ein Ereignis gescheitert ist, und der volle Tag braucht etwa 21.100 Ereignisse von 200.000.

Die meisten dieser Läufe sind Läufe der Workflows des Blueprints, die ein `workflow_run` startet und die ihre Jobs überspringen: Sie kosten je eine Anfrage und nichts weiter. Eine Flotte mit noch mehr Läufen kann die Anfragen an den Worker trotzdem aufbrauchen, denn jeder Lauf ist eine Zustellung; der Plan Workers Paid hat kein Tageslimit für Anfragen.
