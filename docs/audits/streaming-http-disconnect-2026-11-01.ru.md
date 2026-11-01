# Streaming и Agent V2 disconnect

Исходный HEAD9cf3e57. Пользовательские HTML/GGUF/профили не изменялись. Qwen16GiB/64K/mmap/MTPoff сохранена. Защиты памяти не ослаблены, sysctl не менялся.

## Реальный инцидент

application.log: 2026-11-01T14:35:52.530Z, run8f409474-2de0-4a14-80a6-26f2c7b5df1e: upstream closed while reading HTTP framing.
Launcher:16:35:52+02 остановка owned llama-server PID19550 SIGTERM;16:35:54 Memory safety stop. Это один момент в разных timezone. Сервер был ready с16:17:10. Следовательно, disconnect связан с остановкой backend memory watchdog, а не доказанным CUDA crash или HTTP keep-alive bug. Запросы используют Connection:close, повторного использования сокета здесь нет. Старое сообщение watchdog не различало MemAvailable<7GiB и cumulative pswpout>32MiB. Исторических cgroup.events/точных RAM counters недостаточно для выбора между этими причинами; OOM/CUDA/timeout не установлены. Теперь сообщение watchdog сохраняет доступную RAM, swap delta и размер страницы. Порог/поведение остановки сохранены.

## Streaming

v0.2.1: renderer RAF drain с ограниченными порциями и немедленным drain при done. v0.3.1 commit01850f5 добавил ReadyAnswer и transient reviewed-ready для уже проверенного ответа, ограничив progressive fallback400–2200ms. Компонент и store сохранились. Но Rust Agent принимает final candidate только после review и отправляет его целиком ContentDelta; bridge не передавал reviewed-ready. Поэтому этот путь обходил исправление031. Исправлено: accepted content_delta/final_delta передают presentation hint; обычные Chat deltas не получают искусственную per-token задержку. Markdown/history/канонический полный текст сохраняются.

Отдельно найдено настоящее transport buffering: Rust ждал весь HTTP chunk через read_exact, прежде чем разбирать содержащиеся SSE events. Один HTTP chunk может содержать много событий. Теперь читается по доступным порциям до8192bytes с немедленным SSE parsing, сохраняя UTF8 pending bytes, отмену, chunk-size limit и CRLF validation. Неполный EOF не становится успешным tool turn; требуется finish_reason либо [DONE]. Повтор запроса после отправки данных не добавлялся.

Важно: quality review Agent-финалов намеренно остаётся. Отклонённые drafts не превращаются в final answer. Для этих веток первый accepted text по-прежнему появляется после review; теперь он выводится постепенно. Полный критерий отображения всех Agent final tokens до завершения model turn этим изменением не закрыт: нужен отдельно спроектированный provisional/accepted protocol, а не отключение проверок. Это ограничение, не transport TTFT.

## Ошибки и диагностика

UI отличает обрыв соединения от ошибки самого Rust worker; original error остаётся в диагностике. При недавнем подтверждённом Memory safety stop показывается причина; без подтверждения причина закрытия не выдумывается. Указывается сохранность выполненных шагов и ручное продолжение после проверки модели. Нет auto-replay model/tool requests, auto file writes или автоматического restart большой модели. Existing durable transcript/checkpoints сохраняются.

Metadata-only tracing: LOCAL_AI_STREAM_TIMING_PATH для Rust (request/http_status/meaningful_delta/accepted_final_emit, run ID, epoch ms, char counts); LOCAL_AI_STREAM_TIMING=1 для main bridge; renderer localStorage key local-ai-stream-timing=1 создаёт Performance marks stream.ipc/stream.react с correlation ID и counts. Prompts/files/delta text в новые traces не записываются. React mark означает commit компонента, не физическое появление пикселя. Полный real-Qwen per-stage timing trace в этой задаче не собран.

## Проверки

- Build, TypeScript, lint прошли.
- Rust full suite до последнего дополнительного EOF test:437pass,1ignored. Отдельные socket/partial UTF8 tests, ранняя chunk delivery, EOF/reset/cancel/DONE assertions проходят.
- Реальный Electron ReadyAnswer: обычная delta сразу; большой reviewed block частично виден сначала и полностью позже; история без анимации. Store сохраняет canonical text через done и partial text при отмене.
- Реальный Electron+настоящий Rust Agent V2 с controlled HTTP provider: два read_file временного index.html, длинный Markdown/code final, постепенный approved display; следующий запрос оборван в headers. Ошибка видна, requests ровно4 (без replay), hash fixture не изменён. Повторяющийся первоначальный тестовый текст корректно остановлен repetition guard, fixture заменён уникальными абзацами без изменения guard.
- Existing Rust/Main bridge host tests, placement/arguments и launcher tests прошли; Qwen profile/runtime flags не изменены.
- Новая реальная GPU-проверка Qwen, длительные Browser Workspace/long-document workflows и полная fault-матрица server restart/watchdog в Electron не выполнены. Memory guard причина подтверждена историческими логами, не новым аварийным запуском. Полную готовность всех критериев запроса не заявляем.
