# Scenario-aware Browser QA and Verification Gate

Рабочая ветка: `fix/v0.3-scenario-aware-qa`, база `fix/v0.3-p3-stabilization` (`f193d1d`). Пользовательский `runtime/` не включается в коммиты. NEXUS исследован только чтением исходника и read-only SQLite; установленное приложение, `.deb`, main и релизы не изменялись.

## Фактическая диагностика NEXUS

Исследованы task `2dbc4776-04d3-44da-8e5c-ebe4e14bd3df`, conversation `ad00765b-81f3-4d78-bb12-526ad7b54639`, QA report `986aa581-bdba-4c54-875c-40ae95ef0878` и журнал предыдущего реального Qwen run. В отчёте URL оканчивался на `index.html#about`: functional Failed, visual Verified. Ошибки S/A/E использовали `selector:body`, включая скрипты и изменяющийся FPS. В исходнике E действительно определена вместе с Q/W/A/S/D; проблема не в том, что эта клавиша неизвестна. Обновление камеры ограничено режимом приложения и выполняется в animation frame.

Обнаружено несколько независимых причин:

1. `web_project qa path=…` учитывал путь только при отсутствии Page. При уже открытой странице запрос проверки другой сцены мог оставаться на прежнем route. В журнале есть запрос `#universe`, а фактический отчёт относится к `#about`. Исправлено выполнение явно указанного QA path/url и навигация каждого сценария.
2. QA самостоятельно применял WASD, клик и drag ко всякому видимому Canvas. Это не следует из требований приложения. Теперь без сценария выполняется только пассивный smoke: загрузка, наблюдаемые runtime errors, RAF/draw diagnostics.
3. Короткий tap не эквивалентен удержанию для per-frame controls. Сравнение всего текста body одновременно давало ложный failure при неподвижном DOM и ложный успех от FPS/фоновой анимации. Теперь нужны конкретный observer, сравнение до/после и стабильный baseline без ввода.
4. Gate считал общий успешный browser open достаточным Browser evidence. В исторической Task Memory шесть сложных UNIVERSE deliverables имели один `ev-015`. Теперь без покрытия конкретных acceptance criteria такое подтверждение отклоняется.
5. Глобальный epoch делал все проверки устаревшими после любого изменения. Новые browser records сохраняют хеши реально отданных HTML/CSS/JS/прочих assets; независимое изменение не инвалидирует такой proof.
6. Ошибки `deliverables.verify` не попадали в защиту повторяющихся неудачных host/terminal/mutation calls. Добавлена отдельная локальная защита в существующем metadata dispatch. Наличие stale error в журнале подтверждено; точное число идентичных повторов из одного текста журнала не выводилось, поскольку observation results вынесены в отдельные файлы.
7. Реальный новый Qwen тест обнаружил ещё одну гонку: SPA обновляла scene label в следующем animation frame после hash navigation. Однократное чтение precondition было преждевременным. Теперь проверка ждёт ожидаемое состояние ограниченное время до ввода; исходный неуспешный результат сохранён отдельно.

## Карта состояний и данных

```text
User requirements + inspected source
  -> deliverables.criteria (immutable executable acceptance contract)
  -> web_project.qa scenario_refs (Rust resolves trusted definitions)
  -> ProjectBrowserSession (existing approved native Page / CLI fallback)
  -> route + preconditions + required_state
  -> bounded real Playwright input + observations T0/T1[/T2/T3]
  -> scenario result + captures + functional checks
  -> optional BrowserVisionService (independent qualified image opinion)
  -> durable report + served source hashes
  -> Rust verification ledger: criterion coverage + scope + freshness
  -> deliverables.verify / local no-progress guard
  -> Task Memory / checkpoint / renderer report
```

Native Live Browser остаётся той же Page; origin, filesystem scope, CSP, разрешения и сетевые запреты сохранены. Модель, MTP, projector и runtime lifecycle используются через существующие сервисы; новая QA архитектура не подменяет backend capabilities или состояние агента.

## Сценарии и preconditions

Сценарий задаёт id, конкретную цель, target, preconditions, required_state, steps, assertion и timeout. Result хранит наблюдения, captures, причину и связь с deliverable/criterion. Агент выбирает route/state/assertion из пользовательского требования и прочитанной реализации. Runtime не выдумывает обязательное WASD или ожидаемую смену DOM. Незарегистрированные диагностические сценарии допустимы, но не получают acceptance coverage задним числом.

Для browser criteria определяется неизменяемая executable specification. `scenario_refs` воспроизводит её без повторной генерации аргументов. Изменение target, actions, assertion, preconditions или timeout при сохранении criterion ID отклоняется. Load criterion содержит конкретный target; `open` может подтверждать только load. Неправильно составленный контракт требует нового явно отличимого критерия/контракта, а не ослабления старого и повторного использования proof.

Preconditions проверяются до ввода, включая ограниченное ожидание асинхронного state. Неверный режим даёт Blocked/PRECONDITION_FAILED; missing observation — Inconclusive. Доступны только declarative DOM observations и безопасные скалярные пути внутри `window.__qaDiagnostics`; модельный JavaScript не исполняется.

## Canvas и динамические требования

Поддерживаются keydown/keyup/hold, combinations/repeat, focus, click, fill редактируемого поля, mouse move/drag, scroll, wait и проверка pointer lock, полученного самим приложением. Удержанные клавиши и кнопки освобождаются при завершении/ошибке. Нельзя подменять управление `fill(body)`, hidden inputs или принудительным pointer lock.

Для управления используется стабильный observer до ввода и результат после ограниченного удержания. Самопроизвольно меняющееся наблюдение не доказывает причинность ввода. Неизменившийся результат мгновенного tap оставляет неопределённость, а объявленный hold с подходящими preconditions и observer выявляет реальную неработоспособность.

Temporal functional criterion требует минимум трёх временных наблюдений application state. Сохраняются фактические timestamps и соответствующие снимки. RAF/draw counters доказывают только liveness; пиксельная разница и один статический screenshot не доказывают движение камеры или объекта. При отсутствии надёжного observer динамическое требование остаётся неподтверждённым. Vision получает контекст цели и предостережение о фоновой анимации; image-only оценки остаются вероятностными, включая негативные наблюдения.

## Evidence, freshness и Gate

Различаются load/runtime/interaction/temporal/visual/implementation evidence. Каждый acceptance criterion требует своё свежее релевантное покрытие; итоговый proof объединяет эти evidence. Наличие функции в прочитанном исходнике не заменяет её выполнение. Общий open не получает interaction/temporal/visual coverage даже при явном цитировании или metadata association.

Снимок зависимостей связан с реально отданными bytes, а не mtime или модельным fingerprint. Перед verify и финальным review runtime заново проверяет хеши в разрешённом filesystem scope. Изменение зависимого asset, удаление, неизвестная мутация или новый run инвалидируют соответствующее runtime proof. Изменение независимого файла в том же run сохраняет proof. Во время QA параллельная правка проекта делает результат Stale. Предыдущие observations/reports сохраняются; новая проверка выдаёт новое evidence и разрешает verify. Между run сохраняются контракты и наблюдения, но transient browser state требуется установить заново.

После двух одинаковых неудачных verify без релевантного evidence/source progress следующий вызов не исполняется: `VERIFY_NO_PROGRESS`, `retrySameArguments:false` и объяснение нужного retest. Ключ нормализует evidence aliases/порядок и не зависит от текста metadata либо нерелевантного readback. Другие инструменты продолжают работать. Новый релевантный результат снимает этот локальный блок. QA guard отдельно распознаёт повторяющиеся и чередующиеся результаты; timestamps, scenario labels и анимированные счётчики не должны создавать фиктивный прогресс. Перезапуск браузера не обнуляет защиту.

## Статусы и UI

Сохранены совместимые VerificationStatus. Причины уточняют смысл: PRECONDITION_FAILED, UNSUPPORTED_OPERATION, INCONCLUSIVE, EVIDENCE_STALE, QA_TIMEOUT, QA_TOOL_ERROR, AUTH_REQUIRED/PERMISSION_REQUIRED, QA_NO_PROGRESS, FUNCTIONAL_REQUIREMENT_FAILED, VISUAL_REQUIREMENT_FAILED. Real assertion/runtime defect остаётся Failed; невозможность корректно выполнить тест — Blocked или Not Verified. Criterion UI отдельно показывает Stale и частичное визуальное подтверждение.

Панель показывает цель, route, ожидание, наблюдения, причину и связанное требование. Внутренние identifiers/specification/capture details доступны в раскрываемых технических деталях. Функциональный результат и Vision отображаются независимо. Отчёт QA доступен и в Compact, и в Expanded; RU/EN и общие dark theme tokens сохранены. В Task Memory объяснено, что выполненный план действий не равен подтверждённому качеству deliverables.

## Ограничения операций и безопасность

Общего лимита полезных QA-проверок за задачу нет. Сохранены ограничения отдельной операции: до 6 сценариев и 8 действий на сценарий, timeout 0.5–15 секунд, 3–4 temporal samples в пределах 3 секунд, hold до 2 секунд, functional QA deadline 30 секунд, общий QA signal 90 секунд и Vision request 60 секунд. Capture resources ограничены 8 снимками/12 MiB за QA, каждый снимок до 2 MiB и 1280×900. Отдельный explicit screenshot budget (8/run) не исчерпывает interaction QA. Сохраняются bounded source scans, разрешённый origin/GET и существующие security permissions. HTTP 401/403 возвращают Auth Required; обход авторизации не реализован.

## Проверки и ограничения результата

Окончательные машинные результаты находятся в `test-results/scenario-qa/`. Реальное выполнение Chromium/Electron отделено от происхождения provider: deterministic/scripted provider не называется реальным Qwen, seeded UI report не называется реальной проверкой приложения.

- `scenario-qa.test.mjs`: настоящий Chromium и production ProjectBrowserSession; неверный режим, hold/down/up, неизменный DOM, фоновая анимация, three-point motion, mouse drag/focus/scroll, async form/list/modal, сломанное управление, runtime error, явный QA path и HTTP auth.
- `scenario-gate-runtime.test.mjs`: scripted provider, настоящий Rust/Chromium и filesystem; immutable refs, open refusal, dependent/independent edits, stale verify, no-progress guard, свежий retest, следующий run и durable criteria.
- `scenario-qa-electron.test.mjs`: настоящий Electron/preload/SQLite, seeded report; RU/EN, Compact/Expanded, понятная причина, route и технические детали.
- Rust unit/integration tests включают запрет подтверждения шести complex items общим open, scoped proof, immutable weakening rejection, partial visual evidence и durable contracts. Существующий ignored terminal-browser integration test остаётся явно отключённым; не объявляется прошедшим.
- `scenario-qa-qwen.test.mjs`: реальный Qwen3.8-27B Q4_K_M, MTP draft-mtp, CPU mmproj, headed native Electron; воспроизведение/минимальное исправление собственного fixture, реальные image requests, Pause/Resume, Stop и следующий run. Успешный результат сохранён; Pause около 1.2 секунды, Stop около 0.7 секунды. Физическая 3D-геометрия камеры этим счётчиком не проверялась.
- `scenario-contract-qwen.test.mjs`: отдельный реальный Qwen test новых criterion-bound scenario_refs, удержания 500 ms и temporal object state. Предварительный неуспех из-за frame-delayed preconditions сохранён для диагностики; итоговый повтор прошёл: оба deliverable Verified по разным mapped records, камера 0 → 72, distance 99.2 → 95.4 → 91.1. Vision отдельно не различил малое смещение, что не подменяло функциональную проверку.

Не выполнялась модификация/автоматический ремонт пользовательского NEXUS. Без доступного state observer его сложные физические/геометрические требования могут остаться Inconclusive: добавление тестовых hooks в пользовательское приложение требует отдельного разрешения. Vision не является абсолютным доказательством отсутствия всех визуальных артефактов. Loopback приложения не получают фиктивную связь с файлами проекта; без достоверного source mapping их acceptance proof остаётся ограниченным. Asset dependencies записываются отдельно для каждого сценария; навигация в новый документ отделяет зависимости предыдущей страницы. Общий реально загруженный asset может корректно инвалидировать несколько связанных сценариев. Реальная авторизация, arbitrary JS assertions и неограниченное наблюдение не входят в задачу.


## Итог проверки и готовность

Implementation commits: `6b69cda` — scenario runner и маршруты; `daaef28` — criterion-bound Gate/freshness/verify guard; `9251768` — UI результатов; `fdd8141` — document-scoped dependencies и частичные результаты. `420bb85` — diagnostic precondition progress; `2924d89` — автоматизированные и реальные Qwen E2E. Отдельный завершающий коммит сохраняет этот отчёт и evidence.

`npm run build` (Rust binary, TypeScript, Vite/Electron main compilation) и ESLint проходят. Полный Rust suite: **390 passed, 0 failed, 1 ignored**. Ранее отключённый terminal-browser тест не запускался. Итог каждой из 35 regression suites находится в `regressions.json`; реальный Chromium/Electron, Native Browser, security, QA loops, MTP/Vision, runtime controls и UI перечислены там отдельно. Для повторения: `npm run test:scenario-qa`; для двух реальных GPU E2E: `npm run test:scenario-qa:qwen` (требуется свободная GPU).

Backend: `../llama.cpp/build-cuda/bin/llama-server`, **0.4.1-dev, commit d1d3c33**, GNU 13.3.0. Реальные Qwen3.8 MTP+Vision прогоны приняли **2989** и **1041** draft-токен соответственно. Положительный pointer-lock сценарий не заявляется проверенным: явно проверено корректное Unsupported при отсутствии acquisition. Полная Qwen3.6 матрица этого этапа не повторялась.

Готово к пользовательскому тестированию новых сценариев и Gate. Это не утверждение, что все пользовательские NEXUS deliverables доказаны: сам NEXUS не изменялся, сложные требования без надёжного observer остаются честно неподтверждёнными. Main не объединялся, release не создавался, установленный `.deb` не обновлялся.

При восстановлении оставшегося прогона повторялась ошибка `Page.captureScreenshot: Unable to capture screenshot` на первом clipped PNG тестового data-URL. Production QA корректно возвращал QA_TOOL_ERROR/Blocked, а не ошибку приложения. Fixture теперь явно ждёт первый compositor frame перед проверками; повторный изолированный и полный Electron/Native Browser прогоны проходят. Ожидание не подменяет runtime assertion и не повторяет неудачную проверку до получения успешного статуса.
