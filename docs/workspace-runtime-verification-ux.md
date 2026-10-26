# v0.3.0: Browser Workspace, runtime reuse и Verification UX

Продолжение стабилизации в `improvement/v0.3-workspace-runtime-verification-ux` от `da07316`, без новой ветки и без изменения пользовательского `runtime/`. Исходный незакоммиченный прогресс сохранён. Перед продолжением восстановлены diff, tracked acceptance-результаты и процессы. Старые `/tmp`-fixtures предыдущего запуска отсутствовали; новые проверки создают отдельные временные каталоги.

## Изменения

До продолжения уже были исправлены Preview Scale, скрытие Workspace, сворачивание инструментов, runtime reuse и общий manual/auto список. Были обновлены соответствующие acceptance scripts и начато уточнение Verification guidance. Продолжение завершает этот контракт, объяснение статуса, консервативный dedup и проверки.

### Native Workspace

Раньше числовой Preview Scale сохранялся, но при `scale=fit` Native Surface продолжала автоматически вписываться. Теперь числовой выбор доступен в режиме «Фиксированный масштаб» и передаётся как фактический `scale`; «Автомасштаб» рассчитывает размер по доступной панели. Оба режима описаны в UI. Выбранный fixed scale запоминается при переключении режима.

Для CSS viewport **1440×900** фактические `WebContentsView.getBounds()` одинаковы при DPR 1 и DPR 2:

| Preview scale | Native bounds, DIP | CSS viewport |
| --- | --- | --- |
| 50% | 720×450 | 1440×900 |
| 75% | 1080×675 | 1440×900 |
| 100% | 1440×900 | 1440×900 |
| 125% | 1800×1125 | 1440×900 |

Bounds измеряются в DIP, не в физических пикселях screenshot. Дополнительно проверена матрица Auto/fixed viewport × vertical/horizontal layout × четыре масштаба × DPR 1/2. Auto viewport зависит от размера панели, но не меняется от одного лишь presentation scale. Записанные измерения находятся в acceptance JSON.

X скрывает Workspace и освобождает место чату; `close()` не вызывается. Повторное открытие сохраняет session ID, Native Page, viewport, zoom, pan и области. Видимость относится к конкретному чату; новый чат не открывает чужую страницу. Скрытая панель не останавливает агента.

Инструменты сворачиваются независимо от страницы. Навигация остаётся доступна, Native Surface получает освободившееся место. Возврат панели сохраняет настройки. При agent ownership разрешены изменения компоновки/видимости, но не пользовательское изменение viewport, zoom или presentation.

### Runtime reuse

Ранее проверки выбора учитывали только часть launch identity, а совместимый активный runtime не всегда связывался с настройками нового чата. Теперь IPC и UI проверяют fingerprint сохранённого профиля вместе с model ID, context, KV type/offload, MTP и необходимым vision projector. Fingerprint охватывает server/model/projector identity, draft, размещение и launch-параметры профиля. Параметры нового чата можно связать с уже готовой конфигурацией без перезапуска весов.

Composer использует readiness для конфигурации чата. «Готова к работе» означает совместимый ready runtime; несовпадение требует загрузки. Загрузка, занятость и ошибка не считаются readiness. Проверены контролируемые ошибки/устаревшие ответы runtime и context activation. Дополнительный process acceptance использует production Bash supervisor, временный GGUF metadata fixture и настоящий HTTP server child: два SQLite-чата сохраняют один server PID и один запуск.

### Unified Visual Issues

Automatic DOM/layout-кандидаты включены в тот же список, что и manual selections. Совпадающий target объединяет evidence обоих источников и сохраняет пользовательское описание. Для объединения нужны одинаковые URL с query/hash, viewport, уверенный точный anchor и совпадающая категория finding. Разные anchors, дефекты, маршруты и viewport не объединяются только из-за похожести.

Выбор нескольких issues использует одну кнопку «Передать выбранное агенту». В composer добавляются structured region references, сообщение автоматически не отправляется. Проверяются dispute, completion, deletion с подтверждением для нескольких выделений, SQLite persistence, Stop/Continue, immutable history и отсутствие ghost overlays.

### Verification: три уровня

1. `observed_css` — свежее измерение без expected-value assertion, `pass=false`, без criterion coverage.
2. Passing browser criterion — адресный passing результат для зарегистрированного immutable criterion, исходных условий и актуальной ревизии.
3. Verified deliverable — implemented требование, формально подтверждённое через `deliverables.verify` подходящими runtime evidence IDs.

Успешная QA раньше оставляла deliverable implemented, когда агент не вызывал финальный verify. Guidance теперь явно разрешает повторное использование уже полученного passing browser evidence без дополнительного terminal check или идентичной QA. Канонический вызов соответствует опубликованной schema:

```json
{"action":"verify","id":"badge","evidence":"ev-001 ev-002"}
```

`id` — deliverable ID; `evidence` — строка runtime-issued evidence IDs. Criterion IDs используются при `web_project` QA через `scenario_refs`, а не вместо evidence. Старые внутренние aliases остаются совместимыми, но примеры и затронутые fixtures используют канонический вызов. Неверный тип evidence, prose вместо IDs и criterion arguments получают адресную ошибку. Отказ не создаёт новое доказательство.

Для небольшой CSS-only задачи без обязательных criteria свежее scoped observation может разрешать честное завершение по существующему Adaptive Gate; формальный Verified не выдумывается. При обязательных criteria нужны passing evidence для всех критериев и formal verify. UI объясняет отсутствие покрытия, устаревшую ревизию, провал проверки, неподтверждённые исходные условия либо отсутствие final verify при уже пройденных criteria.

Adaptive Verification ON добавляет guidance для соразмерной проверки и bounded review. OFF убирает дополнительную adaptive-инструкцию; инструменты inspect/QA остаются доступны для явного запроса. OFF не превращает observation в pass, не отменяет обязательные критерии, freshness, ownership, privacy или screenshot budget.

## Проверки и ограничения

Актуальные результаты и измерения: [acceptance.json](test-results/workspace-runtime-verification/acceptance.json).

Проверки используют настоящий Electron/Chromium, Rust Runtime, SQLite и временные проекты. Readiness/Gate/Ownership не ослаблялись. Устаревшие fixtures приведены к текущему контракту: явное открытие Workspace, настоящий launch fingerprint, синхронизация renderer после raw IPC, явный выбор продолжения после reload и ожидание polling-проекции UI.

Воспроизводимый screenshot timeout блокировал DOM-only responsive QA при Vision Off ещё до проверки геометрии. Для layout assertions без visual analysis и timed captures raster screenshot теперь не является обязательной предпосылкой. Проверки выполняют те же DOM assertions, viewport, scope и freshness; явные visual/pixel/temporal проверки сохраняют свои снимки и бюджеты. Capture видимой пользовательской страницы не менялся.

Негативные проверки включают неправильный criterion ID, отсутствующее/неизвестное evidence, stale revision, несовпадающие URL/viewport/anchor, mixed CSS+JS/TS, незавершённые criteria, отказ Browser QA и Stop до окончания проверки. Scope/freshness, повторный отказ verify без прогресса и последующий корректный retest проверяются реальным Rust/Chromium scenario-gate acceptance.

Тяжёлый Qwen inference не повторялся. Временный HTTP model-server подтверждает lifecycle/reuse, а не качество inference или загрузку настоящих весов. Vision inference не заявляется. Один существующий Rust integration test остаётся явно ignored upstream; остальные выполняются. Vite сохраняет предупреждение о размере chunks. Пользовательские GGUF, профили, проекты и история не использовались и не изменялись. Merge/release/.deb не выполнялись.
