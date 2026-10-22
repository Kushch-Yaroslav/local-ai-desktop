# Visual Debugging: UX и надёжность browser session

Ветка: `fix/v0.3-visual-debugging-usability`. Этот отчёт описывает изменения после [первоначального внедрения](visual-debugging-verification.md).

## Причина и исправление lifecycle

До исправления реальный Electron regression воспроизвёл последовательность: Native Page ID **2**, после загрузки fixture-модели **2**, после переключения Agent Security сессия закрыта. Отдельная загрузка модели в этом изолированном сценарии не воспроизвела закрытие. Подтверждённая причина — `chat:set-permissions` и `chat:revoke-approvals` отзывали разрешения и одновременно вызывали `liveBrowsers.closeConversation`. Дополнительная причина потери страницы при Stop — abort браузерного tool закрывал общую Page.

Теперь отзыв разрешений отделён от уничтожения browser session. `policyChanged` отзывает авторизацию текущей операции, прерывает её, освобождает ввод и возвращает ownership после завершения операции, сохраняя origin policy. Вручную открытая сессия помечается `userManaged`. Runtime сохраняет её при Stop/Pause и ошибке provider; такая страница также не вытесняется лимитом кеша агентных previews. Это те же `ProjectBrowserSession`, Page, CDP, `WebContentsView` и native input shield. Второй браузер не создаётся.

Явное закрытие пользователем, смена проекта, отключение Browser Tools и уничтожение окна остаются отдельными причинами закрытия. Model load/unload, Vision preferences, Agent Security/Autopilot, отзыв approvals и Browser QA preferences не закрывают пользовательскую страницу. Агент по-прежнему получает необходимые разрешения; ручное открытие не создаёт для него скрытого grant.

## Области, цвета и persistence

«Новая область» создаёт **Область 1, Область 2, …** и включает рисование в неё. В одной области хранится несколько прямоугольников одного дефекта. У области UUID, отдельный монотонный номер и цвет; у каждого прямоугольника сохраняется его прежний region ID. Удалённые номера не переиспользуются.

SQLite сохраняет эти поля в существующем chat/project visual document: `nextAreaNumber`, `issue.number`, `issue.color`, `issue.explicit`. Совместимая миграция дополняет старые группы без замены IDs. Immutable references в истории не переписываются: удалённый из live registry регион можно найти по его сохранённому message snapshot. Цвет выбирается из свободных контрастных цветов; затем доступны дополнительные цвета. Встроенный color picker меняет цвет всей области. Светлая/тёмная двойная обводка, подложка, читаемый номер и текстовый ID позволяют различать области без опоры только на цвет.

Основная панель содержит компактный список областей и небольшую панель инструментов. Описание, статусы, прямоугольники, DOM, preview history и дополнительные возможности раскрываются отдельно. Общая верхняя панель чата не расширена.

## Просмотр и ownership

Клик по области или checkbox фокусирует её прямоугольники; chip открывает read-only просмотр. При user ownership выполняется scroll к уникальному anchor. Если anchor исчез, используются сохранённые координаты и показывается сообщение об устаревании. Усиленная подсветка действует около 2,2 секунды; просмотр не включает рисование новых прямоугольников.

Раньше chip сначала вызывал `visual-debug:open`, а оба IPC — open и reveal — безусловно проходили `visualScope(id, true)`, то есть блокировались как изменение выделений при активном агенте. Теперь reveal разрешён во время run, а open без URL показывает уже живую сессию, не возвращая себе ownership и не создавая Page.

Когда агент владеет страницей, metadata и сохранённый crop доступны; подсветка рисуется на **существующем native input shield**, а не в DOM страницы, и не попадает в QA captures. Прокрутка отложена до user ownership, чтобы не менять состояние агентной проверки. Создание, удаление, цвета, группировка и навигация продолжают соблюдать ownership и active-run security. Crop читается только из управляемого browser-captures cache, с проверкой размера; renderer не задаёт произвольный файловый путь.

## Полный URL и grounding

Сохраняются и передаются pathname, search и hash; например `/index.html?currency=UAH#/shop?sort=price`. HashRouter больше не превращается в `/index.html` или `/`. Известные credential-like URL параметры редактируются в model context, остальные query/hash сохраняются. В UI видны текущий URL, URL области и предупреждение при различии. При другой странице показываются metadata/crop и отдельная кнопка перехода. Простой просмотр не выполняет скрытую навигацию. Смена origin preview требует явного открытия допустимого локального preview и завершает старый origin-scoped session, а не оставляет дубликат.

Runtime передаёт `region_context` с фактическим URL и совпадением references. `REGION_ROUTE_MISMATCH` блокирует read/screenshot/связанный QA на чужом маршруте. Открытие без явно указанного адреса в задаче с одним выбранным маршрутом использует полный reference URL. Для synthetic project preview сохраняется path + search + hash. Для dev server используется полный loopback URL.

Grounding включает имя/текст элемента с безопасными descendant text nodes, selector/classes, bounding rectangle, client/scroll width/height, computed overflow по обеим осям, white-space, text-overflow, visibility, ограниченную геометрию соседей. Приватные controls/subtrees исключаются; input values не читаются, а crops маскируются.

Факты размеров и CSS отделены от candidates: text clipping, horizontal/vertical overflow, overlap и unknown/needs visual confirmation. Для overlap необходимы пересечение **обеих осей**, видимость и hit-test точки пересечения; одинаковая X-координата недостаточна. Styling mismatch требует baseline или визуального подтверждения. Intentional overflow не объявляется автоматически ошибкой. Vision Off не выдаётся за просмотр изображения моделью.

Project-local preview history содержит до шести ранее явно открытых/разрешённых URL или адресов живой разрешённой сессии. Повторное открытие использует живую Page или предлагает сохранённый preview. Порты не угадываются, сеть не сканируется. При неизвестном адресе остаётся ручной ввод.

## Локализация

Используются существующие `t`/`tr`/`localizeMessage`, RU/EN и их fallback. Enum values остаются `Detected`, `Confirmed`, `In progress`, `Fixed`, `Verified`, `Unresolved`; UI показывает «Обнаружено», «Подтверждено», «В работе», «Исправлено», «Проверено», «Не решено». App-owned description отображается как «Предполагаемый дефект». Пользовательские описания, исходный код, ответы модели и protocol values не переводятся и не переписываются.

## Проверки и доказательства

Все тесты используют отдельные временные runtime и проекты, без Online-Shop, NEXUS, пользовательских чатов и runtime. Установленный настоящий GGUF только читался. Deb, merge и release не создавались.

- `npm run typecheck`, `npm run lint`, `npm run build`: успешно; остаётся прежний Vite advisory о размере chunks.
- `cargo test --locked --manifest-path rust-agent/Cargo.toml`: **408 passed, 1 ignored**.
- `scripts/visual-debugging-usability.test.mjs`: legacy migration, IDs/монотонные номера, цвета/SQLite, immutable history references, query/hash, credential redaction, RU/EN/fallback.
- `scripts/visual-debugging-pipeline.test.mjs`: сохранение references, image routing, Vision policy и свежесть Ledger.
- `scripts/visual-debugging-electron.test.mjs`: исходный manual workflow, DOM/Canvas, groups, scroll/viewport/zoom, privacy-mask PNG, canonical references, настоящий Rust fix loop и Ledger; адаптировано ожидание read-only reveal.
- `scripts/visual-debugging-usability-electron.test.mjs`: **18 сценариев** ([scripted-result.json](test-results/visual-debugging-usability/scripted-result.json)), настоящий Electron/Chromium/Rust с **scripted provider**. Открытие; model load/unload; Security/Autopilot/approval revoke; Vision/QA preference changes; пронумерованные области; несколько прямоугольников; разные цвета и color picker; reload; checkbox/chip; активный агент без ownership theft/DOM capture contamination; stale anchor; query + HashRouter; Stop/Pause и последовательные runs; origin security; private input exclusion; clipping 60px без ложного overlap; исправление общего CSS и Verification Ledger; preview history и RU UI.
- `scripts/browser-session-native-electron.test.mjs`: session reuse, permissions, transport recovery, Pause/Resume, Stop/continuation, origin restrictions.
- `scripts/responsive-native-electron.test.mjs`: QA isolation, active-page preservation, Stop/Pause cleanup, RU/EN QA panel.

Дополнительный старый глобальный `localization-coverage.test.js` пока не проходит из-за существующих английских labels в **неизменённых** `ModelProfileEditor.tsx` и `AuthorConfigurations.tsx`. Проверка не отключалась и не ослаблялась. Отдельный scoped AST-check проверяет наличие EN-переводов всех `t`/`tr` строк Visual Debugging, Live Browser и Browser QA controls; RU/EN статусы и fallback проверяются unit/Electron тестами.

Model load/unload в scripted UX suite проходит через настоящий IPC с fixture-managed процессом, а не запускает/останавливает пользовательский llama-server.

### Настоящая Qwen3.6-35B-A3B

Отдельно выполнен `scripts/visual-debugging-qwen.test.mjs` с настоящей установленной **Qwen3.6-35B-A3B-UD-Q4_K_M**, собственным localhost llama-server и временным проектом. На GPU перед запуском было 23079 MiB свободно; существующая модель не выгружалась. Vision Off, контекст **32K**. Первый пробный запуск с 16K корректно отказал по context budget: штатные tool schemas и evidence не помещались; после увеличения только тестового контекста реальный прогон прошёл.

Модель за **55,705 секунды inference/fix run** прочитала source, установила причину clipping, исправила общий `.checkout`, сохранила тексты и несвязанный `#unrelated`, проверила **полный query/hash route** через Browser QA и получила Verified от Ledger. После исправления `clientWidth/scrollWidth`: **181/181** и **151/151**. Native Page ID сохранился, управление вернулось пользователю. Отдельный тестовый server завершён.

В финальном ответе Qwen явно различила clipping и overlap и указала, что Vision был Off. Это результат настоящей LLM, отдельно от scripted provider. Доказательство: [qwen-result.json](test-results/visual-debugging-usability/qwen-result.json).

## Ограничения

- При agent ownership live scroll и переходы откладываются, чтобы не менять проверяемую страницу. Read-only metadata, crop и shield highlight доступны.
- Если DOM существенно изменился, fallback coordinates могут быть неточны; состояние помечается stale. После исчезновения anchor нет выдуманной гарантии сопоставления.
- Source/component mapping по-прежнему подтверждается Project Tools; автоматический framework/source-map resolver и handles изменения размера/позиции не добавлены.
- Preview history хранит известные адреса, но не гарантирует, что остановленный dev server доступен. Ошибка сервера не запускает поиск портов.
- Реальный Qwen test подтверждает один целевой clipping/fix сценарий; он не является аудитом произвольного магазина или всего сайта.
