# No-op и loader: проверка 13 октября 2026

**Историческая запись доказательств от 13 октября 2026 года.** Сохранена для подтверждения происхождения результатов; это не текущая инструкция установки и не приёмка опубликованного v0.2.0 DEB. При очистке документации результаты независимо не повторялись. Актуальные ограничения — в [security reference](../apparmor-security-review.md), условия выпуска — в [архивном checklist](releases/v0.2.0-checklist.md).

Два исходных дефекта исправлены. Финальная сборка и реальная Qwen coding + managed HTTP задача прошли. Системную политику, helper, глобальные настройки, модели и существующие пользовательские записи не меняли. Коммитов, push и DEB нет.

## Изменения

- `rust-agent/src/tools/filesystem.rs`: одинаковый `write_file` возвращает `unchanged:true, written:false` до snapshot/atomic write; повторно проверяет scope и байты. Inode/mtime сохраняются. `create_file` на существующем файле по-прежнему отказывается. `replace_text` с одинаковыми old/new по-прежнему отклоняется без записи.
- Здесь же `apply_patch` сравнивает итоговые байты с проверенными preimages: неизменённые цели не записываются и не получают backup. Полностью одинаковый/взаимно отменяющий патч — no-op; смешанный патч возвращает только действительно изменённые файлы.
- `rust-agent/src/agent/loop_runtime.rs`: только доверенные no-op результаты write_file/apply_patch пропускают mutation/invalidation. Политика разрешений не менялась.
- `rust-agent/src/agent/verification.rs` и terminal ветка loop_runtime: узкое распознавание одиночного literal builtin `printf '%s' ... > файл` или безопасного одноаргументного `echo ... > файл`, включая `builtin`. SHA-256 до/после успешного выполнения позволяет сохранить доказательства при совпадении. Остальные отслеживаемые revisions всё равно сверяются. Это не новый passing check.
- Обёртки, подстановки, pipelines, append redirects, несколько команд и произвольные скрипты остаются консервативно mutating. Нельзя судить обо всех их эффектах по одному совпавшему файлу. Терминальная запись может обновить mtime, даже если байты совпали; для file tools это физический no-op.
- `scripts/sandbox-loader-injection.test.mjs`, `test-fixtures/agent-reliability/sandbox-startup-main.cjs`: исправлен ложноположительный Electron тест. Старый evaluate принимал Electron module вместо переданного объекта marker paths. Новый fixture применяет точные значения, публикует фактическую environment sidecar и ждёт отдельного подтверждения. Тест проверяет пути и отсутствие Rust spawn/provider request ДО разрешения запуска.
- `scripts/sandbox-qwen-electron.test.mjs`: focused `--development-only`, проверки сохранения всего verification ledger/deliverables и свежего passing functional evidence, проверка native shutdown до fallback. В тестовом prompt исправлено число байтов: `stable` — шесть, без newline.

## Целевая синтетическая проверка

- `npm run build`: exit 0; стандартное предупреждение Vite о больших chunks.
- Rust: 27 passed — filesystem 19, literal parser 1, managed stop revision check 1, шесть agent-loop regressions для одинаковых и реальных изменений. Включены inode/mtime, смешанные/отменяющие патчи, сохранение ev- evidence, консервативная инвалидация сложной команды с фактически одинаковой записью.
- `stop-history.test.js`, `terminal-lifecycle.test.js`: exit 0 — Stop/Continue, успех/ошибка/отмена, сохранение истории и завершённых карточек.
- Полный Electron → Rust → Bubblewrap loader regression на финальном binary: exit 0. Положительные контроли LD_AUDIT и LD_PRELOAD доказанно запускают соответствующие markers; фактические LD_AUDIT/LD_PRELOAD пути подтверждены до spawn; в защищённой цепочке markers отсутствуют, confined pwd успешен, tool prompts 0.
- Действующий payload: `local_ai_desktop_bwrap//&local_ai_desktop_bwrap_child (enforce)`, Seccomp=2, NoNewPrivs=1, CapEff=0. Проверка под ручным ELF loader сохраняет child label и ограничения; invalid namespace/mount и host signal-0 запрещены. Прямой dedicated helper exec — 126. Оба установленных профиля enforcing.
- `git diff --check`, Node syntax checks: passed.

Логи: `.ai-research/validation/noop-loader-2026-10-13/` (`final-build.log`, `final-targeted-tests.log`, `final-loader-regression.log`, `stop-tests.log`).

## Реальный Qwen, отдельно от synthetic

Обычная конфигурация `/media/yaroslav/DATA/local-ai-desktop/runtime/app-data/runtime-settings.json`, production Electron main/renderer → IPC → Rust → локальный llama.cpp Qwen3.6, context 65536, q8_0 KV, MTP, Absolute Autopilot. Новый временный проект и test chat; модель/инструменты не замоканы.

Финальный отчёт: `.ai-research/validation/sandbox-qwen-2026-10-13T13-26-17-788Z`.

- Одна совмещённая задача, 43 model requests, 78 model-selected tool calls, около 145 секунд, без timeout.
- File tools, plan, deliverables, pwd/ls/cat/grep; исправление prices.py, invoice.py → 570, 10 unittest tests PASS.
- Managed HTTP start/status → точный JSON `{"status":"ok","total_cents":570}` → stop исключительно своего task_id → подтверждённый connection refusal. Smoke и финальная проверка на динамических портах.
- 5/5 deliverables verified. Реальные write_file и terminal no-op дали `unchanged:true`; epoch 13 → 13, весь ledger и deliverables неизменны, свежие functional proofs сохранены (`noop-evidence.json`).
- Tool approvals 0. Единственное подтверждение выбора Absolute Autopilot — заранее разрешённое операторское действие, без новых tool prompts.
- Native shutdown survivors [], ДО fallback cleanup; final survivors [], cleanup errors []. Config bytes unchanged; existing database rows changed [] (`preservation.json`). Удалён только test chat, его сообщения предварительно архивированы.

Результат не означает отсутствия ошибок модели: 13 вызовов отклонены (слишком длинный task, повторное чтение, выдуманные ev- IDs, pending/stale evidence). Qwen восстановился; проверки не были ослаблены. Все такие события и ответы сохранены в stream/provider trace.

Предыдущие попытки сохранены отдельно: 13:07 — реальная новая правка отчёта после verification и исчерпанный bounded review, не no-op regression; 13:14 — все 5 verified, но излишне строгий assertion требовал metadata verified ещё до no-op (исправлен); 13:21 — все 5 verified/native cleanup passed, но модель назвала фактически отличающуюся запись идентичной, тест это не принял. Финальный тест требует фактического `unchanged:true`, а не слов модели.

## Оставшиеся ограничения

- P2: Qwen иногда переписывает реально изменённые отчёты после checks, выдумывает evidence IDs или пытается verify pending items. Это может требовать дополнительных проверок и упереться в существующий bounded verification review. Настоящие изменения по-прежнему инвалидируют proof; закрывать на это глаза нельзя. Исходная петля из-за одинаковой записи устранена.
- Консервативная инвалидация для произвольных mutating scripts сохранена намеренно. Не обещаем распознавание всех shell effects.
- Прямой ELF loader может исполнять bytes helper внутри уже ограниченного payload, но проверенный путь не возвращает setup profile. Нового общего security-аудита/доказательства отсутствия всех OS bypasses не выполняли.

## Повторение

На собранном приложении, при отсутствии другой активной application/model session:

```bash
node scripts/sandbox-loader-injection.test.mjs
node scripts/sandbox-qwen-electron.test.mjs --normal-configuration --development-only
```

Сборка обычным `npm run build`; не заменять runtime binary посреди активного agent run. Для уже запущенного старого экземпляра новый runtime используется после штатного перезапуска. Sudo/reload политики для этих исправлений не требуется.
