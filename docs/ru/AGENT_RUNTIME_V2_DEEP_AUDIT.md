# Agent Runtime V2 — глубокий аудит надёжности и эффективности

Дата: 2026-10-21. Ветка: `improvement/v0.3-agent-runtime-deep-audit`, база `ecd2412`.

## Методика и границы

Последовательно проверены направления A–J: исходники, границы владения состоянием, действующие тесты и воспроизводимые failure paths. Исправления ограничены существующими transport, transcript, project tools, context projection, plan validation и Electron bridge. Не создавались новая память, новый orchestrator или второй Browser Runtime.

Использованы deterministic OpenAI-compatible scripted providers, реальные файловые операции во временных проектах, SQLite во временных runtime, Chromium и Electron/CDP. Ответы scripted provider не являются реальным inference. Пользовательские GGUF и процессы моделей не запускались и не останавливались; runtime, model profiles, NEXUS и пользовательские проекты не изменялись.

## Карта направлений и проверенных путей

| Направление | Основные компоненты | Проверенные failure paths и результат |
|---|---|---|
| A. Agent Loop | `agent/loop_runtime.rs`, `state.rs`, `control.rs`, Rust `main.rs`, `process/tasks.rs` | Start → tools → review → final; пустой ответ, reasoning-only ответ, continuation, bounded final reviews, Stop активного terminal, Pause во время generation/compaction, повторный Resume. Исправлены transport failures и несовпадение локального/durable retry recovery. Нового дефекта основного Stop/Pause state machine в проверенных сценариях не обнаружено. |
| B. Tool Calling | `transcript::validate_calls`, `tools/mod.rs`, `tools/web.rs`, `run_scoped_tool_authorized`, `context/message_sequence.rs` | JSON object arguments, truncated/malformed calls, повторные IDs в одном turn, call/result pairing, отрицательные approvals, host result ID, ошибки одного вызова в batch. Сохраняется запрет исполнять JSON/команды из произвольного текста. Plan arguments теперь проверяются без молчаливого удаления элементов. |
| C. Context Management | `context/projection.rs`, `runtime_state.rs`, `evidence_projection.rs`, compaction в `loop_runtime.rs`, durable `transcript/evidence` | Сохраняются canonical bodies, tool pairs, current user, summary/tail и изменившиеся runtime sections. Найдены повторные тела одинакового observation recovery; provider projection теперь заменяет старые точные дубликаты короткими receipts. Разные ranges и freshness остаются отдельными. |
| D. Project Tools | `tools/filesystem.rs`, `recovery.rs`, `agent/reads.rs`, scoped config и read budgeting | Два проекта с одинаковым относительным именем; end-line-only ranges; missing → present и changed files; stale write/replace; atomic patch/rollback и `.git` restrictions. Исправлены project identity, range identity и revision snapshot race. |
| E. Browser Tools | Electron `ProjectBrowserSession`, `LiveBrowser`, Native/CDP factory, QA guard, Rust host dispatch | Run A → user → Run B; grants, origin conflict, explicit close/reopen, stopped preview server, watcher reload, isolated responsive/visual pages и Stop/Pause cleanup. Исправлен durable retry guard после подтверждённого recovery. Нового дефекта Native Page ownership/изолированной QA Page в проверенных сценариях не обнаружено. |
| F. Planning / Task Memory | `plan.rs`, `task_memory.rs`, `apply_plan`, durable checkpoints, logical-task IPC | Invalid plan replacement, confirmed-memory evidence validation, saved plan/memory, logical task isolation, compaction + repeated resume без replay edits. Malformed plan call теперь транзакционно отклоняется. План не становится доказательством deliverable; обязательный план для простой задачи не добавлен. |
| G. Verification | `verification.rs`, `deliverables.rs`, scoped terminal/browser evidence, source freshness | Browser open/static image не подтверждают сложный/dynamic criterion; passing scope, stale source, failed check, readback vs functional proof; восстановленный Gate. Исправлена привязка read observation к реально прочитанным байтам. Существующая строгая проверка evidence сохранена. |
| H. Security / Permissions | Rust permissions/policy/isolation, Electron `ApprovalBroker`, `AutonomySessions`, protected runtime | Once/session/reject, revoked grants, same chat/new run, другой project/origin, `.git`, process ownership. Browser QA security mode больше не применяется до принятия control Rust. Recovery не стирает security denial. Нового обхода прав в проверенных сценариях не обнаружено. |
| I. Model Integration | HTTP/SSE `stream_call/consume_sse`, reasoning filters, request reasoning options, template message normalization | Раздельные reasoning/content/tool deltas, fragmented JSON arguments, пустой final, unavailable backend, CRLF SSE, UTF-8 между chunks, timeout внутри HTTP chunk, error SSE. Исправлены подтверждённые transport defects; raw Harmony и текстовые псевдо-tools не исполняются. Family compatibility проверялась протокольными fixtures, не новыми GGUF benchmark. |
| J. Electron / Rust / React | `RustAgentRuntime`, IPC `register-ipc`, renderer `app-store`/`App`, generation guards и persisted runs | Worker preparation failure, rejected control, terminal event ordering, Stop/history, renderer chat switching, pending approvals, final snapshots. Неверный запрос теперь отклоняется до spawn/control ownership. Исправлен воспроизводимый сбой follow-scroll при росте streaming-контента. Актуализированы regression fixtures для пустого реестра моделей, Compact UI и session grants. |

## Подтверждённые дефекты и исправления

### 1. P1 — повреждение или задержка streaming

Входящие блоки декодировались через `String::from_utf8_lossy` независимо: граница TCP/HTTP могла разрезать русскую букву или emoji. Частичное `read_exact` завершалось ошибкой уже после 100 ms ожидания; частичные status/header/chunk-size строки на timeout теряли ранее полученные данные. SSE parser искал только `\n\n`, поэтому CRLF-события задерживались до EOF. Streamed `error` при HTTP 200 игнорировался как пустой model turn.

Реализация сохраняет неполный UTF-8 suffix и позиции частичного HTTP чтения, продолжает ожидание при кратком timeout, проверяет cancellation, распознаёт LF/CRLF boundaries и chunk extensions. Некорректный UTF-8 и error SSE дают явную transport error. HTTP chunk ограничен 16 MiB; проверяется его terminator.

Воспроизведение: тест CRLF до исправления давал `""` вместо `"Привет"`. Реальный TCP fixture разделяет UTF-8 внутри символа, передаёт часть chunk с паузой 140 ms и использует chunk extension; после исправления сохраняется `Привет 🌍`. Нет автоматического повтора частично отправленного inference: ограниченный connect retry остаётся только до submission.

### 2. P1 — неверное повторное чтение другого проекта

Duplicate-read guard и read demand estimation использовали primary root даже при `project=2`. После чтения `shared.txt` из Project 1 запрос одноимённого файла Project 2 возвращал ошибку со ссылкой на observation первого проекта. В scripted integration воспроизведён ошибочный отказ вместо `secondary content`.

Выбранный root теперь определяется существующим `scoped_tool_config` для конкретного call. Project slot учитывается и при формировании parallel read batch. Проверка прав и модель project identity не расширены.

### 3. P2 — end-line-only range ошибочно считался whole-file read

`{"path":"a.txt","end_line":1}` реально читает первую строку, но записывался как `all`. Полное последующее чтение могло блокироваться как дубликат. Общая функция диапазона теперь учитывает обе границы, default start=1 и offset; evidence и guard используют один формат. Новая регрессия сохраняет возможность прочитать оставшиеся строки.

### 4. P1 — read snapshot получал revision более новой версии

После чтения file body bookkeeping и journal повторно читали файл для хеша. Внешнее изменение между capture и append давало старому body новый hash, скрывая необходимость перечитать файл.

Filesystem tool возвращает runtime-generated SHA-256 всей прочитанной UTF-8 версии вместе с bounded body. State и observation используют этот snapshot hash. Тест детерминированно меняет файл между capture и bookkeeping: старая revision сохраняется, external revision считается changed, новое чтение разрешено. Хеш не берётся из model arguments. Убраны повторные чтения содержимого для bookkeeping/journal реального read result; совместимость исторических observations сохранена.

### 5. P2 — malformed plan silently терял шаги

`filter_map` отбрасывал null/число/object без text при `plan set`, после чего сохранял неполный план. Теперь ошибка содержит индекс; весь старый plan/revision остаётся прежним. Поддерживаемый historical object form `{text:...}` сохранён. Regression проверяет три malformed формы и успешную валидную замену.

### 6. P1/P2 — ошибочная подготовка запроса удерживала worker controls

Worker и maps controls/steering создавались до `splitAgentRunHistory`, settings/attachment preparation и до `try/finally`. Исключение при отсутствии текущего user message оставляло ownership для запроса, который не начался. Подготовка перенесена до spawn; regression подтверждает отсутствие `hasRun`/steer после отказа.

Дополнительно удалено преждевременное присваивание `qaOptions.securityMode`: оно происходило ещё до acknowledgment Rust. Test worker отклоняет переход в autonomous, затем запрашивает preview: strict approval по-прежнему требуется и может быть отклонён.

### 7. P2 — повторные observation recovery раздували context

Точное повторение immutable observation slice добавляло вторую полную копию в wire projection. Теперь сохраняется последняя полная копия, прежние идентичные результаты заменяются locator receipts. Call IDs, pairing, canonical journal и тела observations остаются прежними. Это не execution cache и не запрет повторных действий.

### 8. P1 — durable retry guard игнорировал подтверждённое recovery

После предыдущего исправления Resume persisted streak оставался активен даже после того, как существующий local state сбросил ошибку при новом read или browser recovery. Transcript streak теперь учитывает успешное чтение нужного пути/проекта, успешную работу для terminal retry и явно подтверждённый browser recovery нужного project slot. Неуспешный read или другой проект не сбрасывают streak. Security denials не очищаются этим механизмом. Tests проверяют и recovery, и сохранение отказа.

### 9. P2 — streaming growth ошибочно отключал follow-scroll

Production renderer fixture дважды воспроизвёл потерю следования за потоком при явно заданном начальном положении у низа. Обработчик любого scroll сравнивал только расстояние до конца: рост контента/изменение viewport мог увеличить его до выполнения запланированного animation frame. Следование отключалось, хотя пользователь вверх не двигался.

Теперь положение у низа включает follow, а выключение требует фактического уменьшения scrollTop. Состояние корректно инициализируется при переключении чатов. E2E проверяет большую порцию reasoning, tool/recovery events, изменение высоты composer, сохранение позиции явно прокрутившего вверх пользователя, переключение чатов, восстановление/редактирование/regeneration reasoning и freeze terminal clock. Не добавлена принудительная прокрутка после каждого события.

### 10. P2 — ненужный durable scan для инструментов вне retry guard

`failed_tool_call_streak` вызывался до проверки того, применяется ли guard к инструменту. Read-only/plan/memory calls выполняли проход и JSON parsing всей текущей durable истории, после чего результат отбрасывался. Вычисление перенесено внутрь short-circuit guard. Для таких calls scan отсутствует; retry policy для остальных не меняется. Измеренного процента ускорения не заявляем. Сохранность длинной trajectory проверяется scripted сценарием более 256 продуктивных действий.

## Измерения и воспроизводимость

| Сценарий | До | После | Что доказано |
|---|---|---|---|
| CRLF SSE | Тест получает пустое content | `Привет` | Событие обрабатывается до EOF |
| Два project roots, одинаковый path | Project 2 получает duplicate refusal | Два реальных body, 3 scripted provider requests, успешный final | Устранён лишний failed read; экономия токенов реальной LLM не измерялась |
| Изменение между read и journal | Hash снимался с новой версии | Hash принадлежит возвращённому snapshot | Старое содержимое не выдаётся за новое |
| Повторные recovery body: два одинаковых старых view, один latest, другой range и changed freshness | 40 854 context bytes | 25 118 context bytes | Минус 15 736 байт / 38,5% в данном fixture; не показатель ускорения всего Agent Run |
| Invalid plan | Неверный элемент молча отбрасывался | Весь replacement отклоняется | Сохранность старого плана |
| Invalid initial request | Control мог остаться зарегистрирован | Worker не создаётся | Нет stale run ownership |
| Streaming UI после явного перехода вниз | Follow-scroll timeout | Following при росте; явный scroll-up сохраняется | Реальный Chromium renderer regression |

Для повторения: `npm run build`, `npm run lint`, затем `node scripts/agent-deep-audit.test.mjs`. Доступны `--section=rust|host|browser` и повторяемый `--test=<точное имя>` для адресного повторного запуска. Runner создаёт новый `/tmp/lad-agent-deep-audit-*`, пишет individual logs, durations и `results.json`, устанавливает отдельный `LOCAL_AI_RUNTIME_ROOT` для каждого subprocess. Реальные модели не нужны. Timeout останавливает только созданную runner process group.

## Общая регрессия

TypeScript, ESLint и полная `npm run build` прошли после финального production-изменения. Сборка выдаёт существующее предупреждение Vite о крупных чанках.

Rust на финальном production-коде `6790cad`: 304 unit passed, 95 agent-loop integration passed, 1 прежний ignored, runtime protection 3 passed, tool security 5 passed, doc-tests 0. Всего **407 passed, 1 ignored, 0 failed**. Чтобы не повторять длинную trajectory, финальный полный прогон использовал `--skip more_than_256_productive_actions_keep_tools_and_a_legacy_denied_budget_does_not_restore`: остальные 94 integration tests прошли; этот единственный тест прошёл отдельно на том же коде (310 разных файлов, 113,32 s). Его наличие в default runner не отключено.

Чистый итоговый host-прогон: **15/15 suites passed** — bridge, project references/workspace, approvals/autonomy, SQLite/history/recovery, process protection, security, Stop/history, terminal lifecycle, logical tasks, context profiles, generation guard, Browser Vision и QA loop guard.

Чистый итоговый browser-прогон: **10/10 suites passed** — browser session reliability, Native Electron sessions, Scenario QA, Scenario Electron UI, Scenario Gate + Rust, Responsive QA, Visual Layout QA, Native Electron Visual QA, production renderer states и real Electron approvals. Vision inference в этих тестах является fixture/disabled; настоящий Chromium capture не выдаётся за реальный мультимодальный вывод.

Числовые результаты и durations: [machine-readable summary](../test-results/agent-runtime-deep-audit.json). Полные individual logs и screenshots финальных host/browser fixtures сохранены в `/tmp/lad-agent-deep-audit-HZFdGa` и `/tmp/lad-agent-deep-audit-PAnNfb`; временные runtime и screenshots в Git не включены.

Первичные падения test fixtures разобраны, а не пропущены: explicit test-only Qwen registrations и небольшие GGUF metadata fixtures заменяют прежнюю зависимость от встроенных моделей; mock MTP identity согласован с mock backend; Compact QA controls раскрываются явно; fixtures предоставляют текущие Vision/MTP API; Thinking выбирается по accessible label; отзыв проверяет конкретный session grant. Реестр, capability checks и UI production ради тестов не ослаблялись. Все runtime/artifacts этих тестов находятся во временных каталогах.

Одно первоначальное Rust-падение было устаревшим ожиданием предыдущего аудита: восстановленный change ledger теперь даёт один review для reachable unverified behaviour. Regression уточнён без ослабления Gate: integrity не вызывает review, отдельное непроверенное behaviour вызывает ровно один. В финальном прогоне эта проверка прошла.

## Риски и оставшиеся ограничения

- Scripted providers проверяют orchestration и protocol, но не гарантируют качество решений конкретного Qwen/Harmony checkpoint. Новых реальных LLM-тестов и замеров inference/tokens не проводилось, чтобы не затрагивать пользовательскую модель.
- Transport остаётся существующим local HTTP клиентом. Полноценный generic HTTPS/proxy/SSE client — отдельное изменение; он не добавлен в этот аудит.
- Task Memory содержит исторические выводы модели. Runtime проверяет provenance и freshness evidence, но не может механически подтвердить истинность каждого semantic finding или полноту пользовательского задания.
- Journal и SQLite имеют разные границы записи. Обычный Pause/Resume и восстановление сохранённых runs проверены, но crash-window между durable pause checkpoint и получением Task Memory projection в Electron принудительно не воспроизводился. `restore_task_memory` отдаёт приоритет supplied projection; глобальная версия всего состояния (включая plan/deliverables) — предмет отдельного compatibility review, а не объявленный исправленный crash defect.
- Verification freshness для неизвестных terminal side effects остаётся консервативной. Изменения вне отслеживаемых файлов и внешние процессы не становятся полным trusted operation journal.
- Общий verification ledger содержит relative и canonical path aliases. Разделение всех persisted aliases строго по project identity требует отдельного compatibility review; этот аудит исправляет доказанный duplicate-read defect, не вводит рискованную миграцию ledger.
- Context byte reduction измерена только на заданном повторном recovery fixture. Сквозные latency, tool calls и completion rate реальных моделей не объявляются улучшенными на выдуманный процент.
- Не выполнялось исчерпывающее доказательство отсутствия любых race conditions. Для исследованных A–J приведены конкретные границы и воспроизводимые проверки; крупный redesign не предпринимался.

## Коммиты

- `1f3cc50` — streaming UTF-8, partial HTTP frames, CRLF и provider errors.
- `32f28a2` — project/range identity duplicate reads.
- `68d8dc3` — captured read revisions и freshness.
- `4bb33ac` — atomic plan validation.
- `fa80845` — pre-spawn request validation и acknowledged security mode.
- `c82fcf5` — duplicate observation recovery projection.
- `bbe6b02` — scoped durable retry recovery.
- `9be6810` — regression rejected security control.
- `41c3fba` — regression восстановленного Gate и unreachable integrity.
- `0b8e373` — изолированные model-profile fixtures для IPC.
- `5509885` — streaming follow-scroll и production renderer regression.
- `141217e` — Electron fixture contracts и scoped grants assertions.
- `6790cad` — отсутствие лишнего durable retry scan для read/plan/memory.
- `49625e6` — изолированный воспроизводимый runner всех regression suites.

Остальные test/documentation commits перечислены в Git истории этой ветки. Изменения не объединялись с `main`; релиз, установка `.deb`, модельные загрузки и миграции пользовательских данных не выполнялись.
