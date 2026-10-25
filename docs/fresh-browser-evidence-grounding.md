# Fresh Browser Evidence and Visual Grounding

Ветка: `fix/v0.3-fresh-browser-evidence-grounding`, от `c6d7fe8`.

## Что доказано

Две сохранённые пользовательские трассы прочитаны только для диагностики. Online-Shop, его dev server, пользовательские сообщения, runtime и модельные профили не изменялись.

- После правки CSS Modules менялся generated class hash. В запуске `bae7f5e3…` четыре последующих inspect старого `aside._summaryCard_11i47_7` возвращали `matches: 0`. В `44a1ecf0…` розовый computed background получен в `obs-00000005` **до** успешной мутации `obs-00000010`; после неё исходный selector больше не находил карточку. Измерения body/html с прозрачным фоном не измеряли карточку.
- Старый inspect возвращал matches=0 как обычный ответ, без stale-anchor error. Поэтому это не доказательство сохранения розового CSS после HMR.
- Весь текст страницы предшествовал inspection. В observation с исходным розовым фоном styles начинаются на символе 16 229, тогда как observation_read ограничен максимумом 16 000 символов. Recovery первой части этого ответа не давал модели искомые styles. Точный исходный payload прежних запусков не сохранён, поэтому нельзя утверждать, что каждый обычный turn был обрезан именно так.
- Сохранённый region включает исходные computed styles и crop. Его live field содержит только геометрию на момент отправки, не обновлённые CSS и пиксели. Исторические данные повторно доступны в контексте; явного разделения всего пакета на original/current прежде не было.
- В обоих старых canonical RunUser есть один PNG data URL. Screenshot observations сообщают `Vision Auto: capture retained without a scoped visual question`, `analyzed: false`. Следовательно, эти трассы не подтверждают Vision OFF: исходное изображение принято runtime, но новые screenshots не анализировались. Наличие PNG в accepted transcript не доказывает правильность визуальной интерпретации моделью.

Не обнаружено доказательства, что Browser Tool после правки возвращал кешированный розовый computed style вместо фактического белого. На fixture Native Page обновляется через существующий HMR; новый inspect непосредственно читает этот же DOM.

## Контракт данных

`ORIGINAL ISSUE EVIDENCE` явно маркирует неизменяемые region anchors/styles/findings/crop как historical. Geometry-only live projection относится к моменту отправки и после дальнейших изменений тоже становится историей. SQLite capture не перезаписывается.

`CURRENT BROWSER OBSERVATION` содержит актуальные computed styles, geometry, observedAt, document timeOrigin/HMR marker, browser session identity, URL/viewport и anchorResolution. Inspect больше не подмешивает полный текст и ссылки страницы; сам inspection расположен первым. Observation Store сохраняет исходное тело под новым штатным Observation ID. Inference получает его вместе со штатной ID-аннотацией. Восстановленная observation остаётся историческим измерением на указанное время, не новым DOM read.

`VERIFICATION RESULT` хранится в существующем Ledger. Новые observedAt/provenance/anchorResolution сохраняются вместе со styles и source revisions. CSS observation остаётся `pass: false`, без immutable criterion coverage; формальный Verified не подделывается.

## DOM anchoring

Общий self-contained resolver применяется к Browser inspection и проекции рамок. Сначала проверяются точный selector, tag и сохранённая текстовая идентичность. При потере CSS Modules hash допускается ограниченный поиск: тот же tag, module class stem, безопасный текст и доступный parent context, не более 200 кандидатов. Допускается только один однозначный результат. Для старых captures без identity используется сохранённый непустой текст; неизвестные/пустые привязки не угадываются. Поиск не использует старые координаты и не читает значения input.

Generated hash может измениться, но UUID области и исходное evidence сохраняются. Ответ указывает originalSelector и фактически resolved selector. Missing/ambiguous/identity-changed anchors дают STALE_DOM_ANCHOR с `retrySameArguments: false`. Отказ не является текущим измерением цвета.

Если между CSS sample и metadata read меняются source timestamp, HMR marker, документ, URL или viewport, ответ получает BROWSER_OBSERVATION_CHANGED и possibly-stale. Разрешена новая попытка после стабилизации; чередование stale/HMR ошибок входит в существующий bounded loop guard и resumable Stop. Security/origin restrictions не менялись.

## Stop/Continue и compaction

Новая сквозная регрессия обнаружила отдельную проблему: Browser Tools брали anchor hints только из последнего user message. После Continue без новых chips исходный region оставался в transcript, но hints терялись. Теперь они восстанавливаются из сообщений **того же logical task**. Независимая задача не наследует регионы другой задачи. Project scope дополнительно фильтруется как прежде.

Проверены настоящий Stop, Continue, compaction через scripted provider, повторный live inspect и фактический финальный inference payload. Свежий белый CSS не заменяется исходным розовым snapshot. Исходный SQLite region остаётся неизменным.

## Screenshots и Vision

Screenshot возвращает время, URL, viewport, crop, capture provenance и HMR freshness на момент capture. Изменение страницы во время capture даёт unknown freshness. Путь PNG не означает передачу пикселей task inference. `pixels_available_to_task_model: false` явно отделяет metadata/path и возможный текст отдельного разрешённого Vision analysis от исходного PNG. В Vision OFF анализ не выполняется. Native image attachment при подтверждённой capability остаётся отдельным существующим путём; неподдерживаемая capability не включается. Privacy masks и logical-task screenshot budget не менялись.

## Сопоставление слоёв на fixture

Region `region-900908f2-4827-4697-ad51-79c0fe2d4d56`, Native WebContents ID `2` сохраняются. Старые crop и region styles не перезаписываются.

| Поле | Исходный capture | После исправления |
|---|---|---|
| Background | `rgb(255, 228, 230)` | `rgb(255, 255, 255)` |
| Source revision | `93c1d016e046…` из read_file | `f4321ef63e70…` из trusted task mutation/Ledger |
| Timestamp | `2026-10-25T14:16:44.259Z` | `2026-10-25T14:16:49.500Z` |
| DOM selector | `aside._summaryCard_3nc3h_1` | `aside._summaryCard_9z7dr_1` |
| URL | исходный query + HashRouter | совпадает |
| CSS viewport | 1920×1080 | 1920×1080 |
| Provenance | historical-user-selection | current-browser-observation |

У самого capture sourceHints пусты: связь с исходником не выдумывается. Revision берётся из чтения/мутации проекта и Ledger; это не source-map доказательство. В тесте цвет сопоставлен между прямым Native DOM, raw tool result, immutable observation file, реальным HTTP inference payload и Ledger. Fault injection отдельно возвращает розовый sample при изменившемся HMR marker: он помечается possibly-stale, следующая inspection получает белый; stale sample не превращается в Verified.

## Активная конфигурация модели

Верхний индикатор использует ready launcher/runtime state. Селектор использует выбранную/сохранённую конфигурацию чата. При их различии теперь всегда показывается необходимость загрузки, даже без нового UI draft. Подписи RU/EN: «Активно сейчас» / «При следующей загрузке».

В Electron fixture применены 32K FP16 и 64K Q8; выбор другой конфигурации не меняет активную до явного reload. Проверены renderer reload, сохранение истории, переключение чатов, rollback и состояние выгруженной модели существующим context-profiles suite. GPU/launcher в этих UI тестах заменены fixture, это не настоящая загрузка GGUF 64K. Настоящий Qwen server в отдельном запуске использовал CLI `--ctx-size 32768`, `--cache-type-k f16`, `--cache-type-v f16`. Пользовательский launcher при диагностике сообщил stopped; его прежние активные 64K подтвердить текущим состоянием нельзя.

## Настоящая Qwen

Один контролируемый запуск Qwen3.6-35B-A3B на временном React/Vite CSS Modules fixture завершился успешно. Vision OFF подтверждён нулём image parts в фактических inference payloads. Записаны 15 запросов (включая summary), полный event trace, наблюдения и результат в `/tmp/lad-adaptive-real-qwen-tZK32O`. Собственный server завершён штатно.

- Первое правильное изменение CSS: 51,128 с.
- Белый фон в Native Page: 51,130 с.
- Inspect старого selector безопасно разрешён в новый hash и вернул `rgb(255, 255, 255)`, freshness updated.
- Эти значения действительно вошли в последующий inference payload.
- Завершение workflow: 110,126 с; после white inspect до done — 53,626 с.
- Visual Issue completed, formal Verified не установлен; screenshot budget израсходован на 0 captures, helper scripts не создавались, immutable criteria не регистрировались.

Ограничение: выполнение ещё не оптимально. Модель сама сделала один reload после уже сработавшего HMR и попытку formal verify. Gate добавил один review: ранние терминальные grep/find с stderr redirection были консервативно учтены как unknown changes/glob paths. После actionable отказа observation-only verify модель завершила задачу; многоминутного поиска несуществующего розового CSS не было. Классификация terminal effects не ослаблялась ради этого теста. В финальном тексте модель повторила исходный selector в таблице, хотя tool честно сообщил новый resolved selector; это ограничение точности модельного ответа.

## Воспроизведение и результаты

После `npm run build`:

- `node scripts/fresh-browser-evidence-electron.test.mjs`
- тот же script с `--resume` и отдельно `--dpr2`;
- `node scripts/runtime-context-state-electron.test.mjs`;
- `node scripts/context-profiles-electron.test.mjs`.

Нужен рабочий DISPLAY. Electron сценарии запускаются последовательно, все изменяемые fixture/runtime находятся в `/tmp`. Результаты quality gates, acceptance и обезличенные реальные метрики сохранены в [validation.json](../test-results/fresh-browser-evidence/validation.json). Сырые пользовательские transcripts и изображения в Git не копируются.

Итоговые quality gates: TypeScript, ESLint, build — PASS; полный Rust suite — **419 passed, 1 ignored**. Все **15** последовательных acceptance-сценариев пройдены; отдельно пройдён полный context-profiles Electron suite. После последних защитных условий повторены fresh/DPR2/Stop–Continue–compaction сценарии, все PASS. Read-only проверка host `/proc` не обнаружила оставшихся fixture-процессов; пользовательским процессам сигналы не отправлялись. Существующие Vite chunk-size и Rust unused_mut warnings не исправлялись как несвязанные.
