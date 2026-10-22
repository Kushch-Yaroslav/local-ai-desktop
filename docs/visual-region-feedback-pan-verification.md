# Visual Region Feedback, Grounding & Mouse Pan

Ветка: `fix/v0.3-visual-region-feedback-pan`. Проверки выполнялись с отдельными runtime и React/HTML fixture-проектами в `/tmp`. Пользовательские runtime, модели, история, Online-Shop и NEXUS не изменялись. Merge, release и установка пакетов не выполнялись.

## Причины дефектов

**Мигание.** Воспроизведено на живой Native Page: CSS viewport 1920×1080, scale 100%, Fixed. X11-захват только окна fixture, 60 fps: два тёмных кадра с яркостью 19 вместо 240 во время `Page.captureScreenshot`. Идентичность, visibility, ownership и bounds Native View сохранялись; навигации и пересоздания Page не было. A/B с одним `captureBeyondViewport:false` всё ещё давал тёмный кадр. Замена capture на `WebContents.capturePage` дала ноль тёмных кадров. Эти наблюдения связывают сбой с compositor/CDP capture, а не с уничтожением браузера.

**Исчезновение рамки.** Старый drag overlay и кратковременный focus overlay не представляли постоянное отображение сохранённых регионов. После завершения выделения/таймера рамки исчезали. Теперь черновик выделения и сохранённые annotations имеют разные жизненные циклы.

**Неточная привязка.** На повторяющихся React-карточках селекторы `.buy` и `.label` неоднозначны; единственный уверенный кандидат мог оказаться широким `main`. Теперь строится проверяемый уникальный structural selector с guard по безопасному тексту и контексту. Это подсказка DOM grounding, не доказательство связи с исходным компонентом. При исчезновении/неоднозначности anchor рамка не переносится на случайный элемент.

**Ошибка закрытия.** Последний скриншот был launcher popup после `Electron exited status=139`, а не JavaScript exception. Лог содержал такой exit три раза и перед последним X11 `DrawableError`; production `before-quit` не дожидался закрытия Browser Hub sessions, затем вызывал `app.exit`. Теперь shutdown ждёт закрытия sessions, Page, Native WebContents и CDP. Тест завершает зарегистрированную Hub session до exit. Отдельная ошибка `detachPan` после уничтожения shield также исправлена сохранением ссылки на WebContents. Лог показывает более поздний запуск с `status=0`; исходный launcher popup оставался от предыдущего сбоя. Подробности: [отчёт закрытия](native-browser-shutdown-verification.md).

## Реализация

- Постоянный pointer-transparent слой с закрытым shadow root отображает все сохранённые прямоугольники, цвета и текстовые номера. Выбранные рамки толще; снятие выбора оставляет обычную рамку. «Показывать выделения» меняет только presentation state, без записи SQLite.
- После mouseup остаётся нейтральный pending-прямоугольник до сохранения. Только успешный SQLite callback публикует цветной сохранённый регион и статус успеха. Ошибка сохранения публикует явное сообщение и удаляет черновую рамку.
- При user ownership рамки находятся на странице. Во время agent ownership та же геометрия отображается на существующем native input shield: проектный DOM и QA screenshot не загрязняются annotations. Второй project Page не создаётся.
- Единая `projectVisualRegion` рассчитывает частичное выделение относительно DOM anchor. Изменение scale/pan не переписывает исходные rect, screenshot metadata или URL. Resize/layout/scroll учитываются через актуальные DOM rect. Поиск selector кешируется до реальной DOM mutation/resize/scroll; pan не означает DOM mutation.
- Причины stale доступны в UI: другой URL, элемент отсутствует, неоднозначная привязка, изменённая identity, скрытый элемент, DOM ещё загружается, неподдерживаемый transform, изменившийся screenshot-only контекст. Периодическая проверка геометрии восстанавливает временно недоступный элемент после DOM mutation; бесконечной цепочки inference/retry нет.
- Checkbox, номер области, конкретный region и chip используют один путь focus. Проверяются полный URL с query/hash и session identity. При необходимости смещается presentation pan к прямоугольнику справа. Прокрутка страницы разрешается только при пользовательском владении; при agent ownership остаются безопасные pan и preview без изменения URL/DOM/scroll сайта.
- Удаление синхронизирует SQLite, canonical list и overlay. Исторический reference остаётся immutable и помечается удалённым. Дополнительно проверена гонка: удаление во время ожидающего focus не может восстановить рамку.

## Средняя кнопка

События `before-mouse-event` перехватываются до передачи сайту. Drag использует глобальные DIP-координаты курсора: движение самого дочернего View не вызывает скачка начала координат. Панорамирование ограничено размером поверхности и объединяется с интервалом 16 ms. Оно меняет только presentation pan, сохраняя CSS viewport, browser zoom, DOM и page scroll.

Во время drag существующий shield принимает ввод; средний клик не открывает ссылку, не вызывает paste/Chromium autoscroll и не создаёт Visual Selection. Отпускание кнопки, blur, выход за окно, смена владения и закрытие очищают gesture и таймеры. На agent shield разрешено read-only перемещение поверхности без передачи контроля над страницей пользователю.

## Координаты, screenshots и приватность

CSS rect, document scroll, browser zoom, display scale, presentation pan и DPR остаются отдельными величинами. Общие преобразования используются native surface и shield. Agent CDP input учитывает presentation scale; pan применяется родительским View и не вычитается из CSS input второй раз.

Crop живой страницы копируется из compositor с переводом CSS/document rect в native presentation DIP. В metadata сохраняются фактические размеры PNG и coordinate space; маленькое Fit-изображение не выдаётся за полноразмерный crop. Маски скрывают editable/private controls, а annotations исключаются из evidence. Маски расширены на два presentation DIP, чтобы округление и antialiasing при очень маленьком Fit не оставляли немаскированную кромку. Изолированные QA captures продолжают использовать существующий путь.

## Проверки и результаты

Полный список результатов и измерений: [JSON/логи](test-results/visual-region-feedback-pan/).

- `native-browser-shutdown-electron`: полный выход с активной Browser Hub session, повторный close, window destroy, shield-first, debugger detach и активный pan. До фикса listener был воспроизведён `removeListener`; после shutdown ждёт `WebContents.isDestroyed()` и завершение controls до `app.exit`, без uncaught exception/unhandled rejection.
- `visual-region-feedback-electron` при DPR 1 и 2: реальный React fixture, одновременные рамки разных групп, partial selection, Fit/50/100, resize/pan, checkbox, show/hide без SQLite write, focus справа, crop red/blue pixels, privacy pixels при browser zoom 80/100/125, отказ SQLite, удаление/history/reload, stale identity и scope security.
- Физический middle-button drag проверяется X11/XTest, а не JS pointer-event имитацией. Pan изменился с (700,150) на (796,198); CSS viewport 1920×1080, browser zoom, document scroll и region IDs сохранились. После mouseup движение прекратилось. Проверены конфликт с selection и read-only pan при agent ownership.
- Растровая проверка при DPR 1: 180 кадров, 0 тёмных, минимальная яркость 240 после исправления. Это измерение конкретного fixture/системы, не гарантия отсутствия любого GPU-сбоя на любом драйвере.
- `visual-regions-workspace-electron` при DPR 1 и 2: responsive 390/1920/4K, partial anchors, CSS transforms/zoom, browser zoom, scrollbar pan, screenshot-only stale, privacy, delete/focus race, сохранение после renderer reload и один project Page.
- `visual-debugging-usability-electron --workspace`: настоящий Rust Agent Runtime со scripted provider, 18 проверок; модели/настройки/ownership, Pause/Stop, chips во время агента, исправление CSS clipping во временном проекте и unqualified proof Verification Ledger.
- Responsive Native QA и Visual Layout Native QA; unit suites deletion/usability/pipeline; TypeScript, ESLint, `npm run build`; Rust: 408 passed, 1 ignored.

Настоящая Qwen в этом изменении не запускалась. Результаты scripted provider не являются проверкой качества LLM или Vision inference.

## Производительность и ограничения

Постоянного screenshot loop нет. DOM-геометрия проверяется максимум 10 раз/с; host poll — 5 раз/с только при наличии регионов; перерисовка выполняется при изменении геометрии/state. Capture вызывается по запросу. Сохраняется один Native project Page плюс существующие renderer/shield.

В коротком 4K Fit-прогоне после очистки регионов native renderer сохранил PID, потребил 0,03 с CPU при DPR 1 и 0,05 с при DPR 2 за примерно 2 с наблюдения; working set около 128 MiB, click roundtrip 16/23 ms. Это небольшой статический fixture без активных annotations, не нагрузочный benchmark магазина. Полные process metrics сохранены в `workspace-dpr1.json` и `workspace-dpr2.json`.

Screenshot-only/Canvas не обещают точный перенос между разными responsive layouts, DPR/zoom или перезагрузкой документа. Rotation, mirror и 3D transforms требуют повторного выделения; положительные translate/scale и частичные rect поддерживаются. Structural anchors могут устареть при перестройке повторяющихся карточек: guard уменьшает риск ложной привязки, но не является стабильным application ID. Очень маленький Fit даёт низкое разрешение crop; для деталей следует увеличить display scale. Масштаб не меняет layout сайта. Нагрузочный тест больших реальных SPA и разных GPU не проводился.

Коммиты: `078e901` — capture/annotations/anchors; `2192d9f` — feedback/focus/i18n; `7c60315` — native pan/закрытие; следующий commit — регрессии, privacy rounding и документация.
