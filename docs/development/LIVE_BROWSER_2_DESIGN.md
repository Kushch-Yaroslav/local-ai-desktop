# Live Browser 2: повторное исследование и решения

Исследование 2026-11-08 завершено до реализации. Оригинал читался только read-only.

## Реальные контракты оригинала

`src/main/web/native-project-page.ts`: WebContentsView + изолированная session, ConnectOverCDPTransport выдаёт ровно один target. Нет screencast-посредника. `webContents.setZoomFactor` меняет browser zoom; CSS viewport = выбранный физический размер / zoom. DPR берётся от display и не служит заменой zoom. fit = min(panelW/(cssW*zoom), panelH/(cssH*zoom)); fixed preview scale независим от zoom. Pan хранится в CSS px; presentation=(css-pan)*zoom*previewScale. Auto выбирает viewport от bounds панели. Средняя кнопка двигает preview через экранные DIP, wheel над страницей прокручивает страницу, pan-pad/scrollbars двигают поверхность. Resize grabber ограничен 240..4096 и pixel budget. Input shield разделяет ownership, освобождает нажатые keys/buttons при hide/blur, скрытие не закрывает Page.

`LiveBrowser.tsx`, `BrowserWorkspaceControls.tsx`, `styles/app.css`: split ratio 25..75%, keyboard separator, browser-first при узком workspace, вертикальные/горизонтальные инструменты с collapse и регулируемой шириной. Preferences связаны с conversation через visual document; отдельный popout не обнаружен.

`visual-selection.ts`, `VisualDebugPanel.tsx`, `services/visual-debugging.ts`: многорегионные области, bounded DOM, geometry/identity/selector, исторические crops, reveal без ложной навигации, DOM-only detect кандидаты, история и workflow. Canvas/SVG/WebGL не получают выдуманный DOM source. Recheck проверяет исходные URL/viewport/anchors и revision ledger; Verified запрещён без доказательств. Workflow completed не равен Verified.

## Goose и текущие регрессии

`runtime/browser.ts` сейчас меняет DPR для псевдоzoom; SSE canvas не обеспечивает native IME/drag/upload. `LiveBrowserPanel` занимает пространство постоянно и смешивает технические/основные controls. `useChatSession` добавляет служебный текст в userMessage и потому портит persisted history. `pendingContext` singleton заменяет вложения других чатов.

ACP уже сохраняет annotations.audience в `convert_acp_prompt_to_message`, provider projection исключает user-only blocks, replay исключает assistant-only. Но edit сначала truncate, потом resend: для корректного retry нужна независимо сохранённая attachment reference, а не скрытие CSS. `SessionManager` сохраняет extension_data при truncate/fork, поэтому attachment registry может жить там и восстанавливать model context по ID без повторного DOM/crop захвата.

Project ID в Goose — отдельный session metadata; working_dir сам по себе не выбранный проект. `sources::read_project/project_working_dirs` и session project binding должны быть источником корней. Метаданные браузера не должны расширять filesystem permissions.

## План реализации и проверки

1. Backend-owned typed attachment registry, компактная user-only reference и assistant-only context. Retry/fork/reload разрешают ID через registry; Vision Off не сохраняет/не отправляет crop. Добавить backend/renderer tests.
2. Компактный header/navigation, раскрываемые display controls, закрытый по умолчанию inspector со списком областей/фокусом, проектный scope и явные modes.
3. Нативная Electron поверхность через ограниченный one-target CDP bridge; сохранить внешний runtime MCP/grounding как единого владельца Page. Native input/IME/zoom; viewport/preview/pan раздельно. SSE остаётся state transport и fallback, не имитация native input.
4. Persist/reconnect, evidence guard/recheck и lifecycle tests. Сборка только в отдельный output; проверка окон/визуального вида/annotations в изолированном профиле. Основной установленный экземпляр не заменять и не останавливать.

Ни один пункт плана сам по себе не означает полного паритета; фактические результаты фиксируются отдельно.
