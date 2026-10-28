# Changelog / История выпусков

User instructions are in the [English](docs/en/USER_GUIDE.md) and [Russian](docs/ru/USER_GUIDE.md) guides. This file summarizes changes; it does not replace the guides.

## v0.3.0 — 2026-10-28 — Experimental Alpha (local release)

### Added

- Read-only Chat tools for selected projects, the approved Browser Workspace and Visual Regions, plus supported attachments, persistent conversation-scoped sources, progressive large-document reading, saved progress and recovery after Stop, compaction and restart.
- Chat project exploration is read-only: scoped file listing, text/file search and bounded file reads; browser diagnostics read the existing approved page without navigation or interaction.
- Agent Runtime V2 improvements, persistent task state, stronger recovery and verification workflows.
- Browser Workspace with native and live previews, resizable/custom viewports, visual regions and browser QA evidence.
- Model profile and GGUF availability improvements, cold-start recovery, context controls, MTP and vision capability diagnostics.
- Segmented Chat output orchestration with a cumulative output budget up to 50K tokens, plus a live context monitor for Chat and Agent.

### Changed

- Linux model discovery refreshes after a removable GGUF drive is mounted. See [GPU performance troubleshooting](docs/gpu-performance-troubleshooting.md) for hardware and context guidance.

### Known limitations

- This locally prepared Experimental Alpha is not published. The 50K figure is an orchestration budget: a model can stop naturally earlier, and long answers still need review for coverage and repetition.
- Model support and performance depend on the GGUF, `llama.cpp`, available memory, GPU and projector placement. Models and `llama.cpp` are installed separately.
- Agent can change project files. Its terminal isolation is enforced but is not a privacy boundary for every readable host file or network access.
- This package is validated on the current Ubuntu machine; a clean-install and broad distribution matrix have not been independently verified.

[Release notes (EN)](docs/releases/v0.3.0.md) · [Примечания (RU)](docs/releases/v0.3.0.ru.md)

## v0.2.1 — 2026-10-16 — Experimental Alpha (pre-release)

### Fixed

- Agent can check selected local web projects and explicitly approved local web addresses with the browser tool, including page navigation, DOM inspection, JavaScript and console errors, and screenshots.
- Public web tools remain limited to public web access; they do not gain arbitrary access to local addresses.

[Release notes (EN)](docs/releases/v0.2.1.md) · [Примечания (RU)](docs/releases/v0.2.1.ru.md) · [GitHub Release](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.2.1) · [amd64 DEB](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/download/v0.2.1/local-ai-desktop_0.2.1_amd64.deb) · [SHA256SUMS](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/download/v0.2.1/SHA256SUMS)

## v0.2.0 — 2026-10-15 — Experimental Alpha (pre-release)

### Added

- Continue saved Agent tasks across chats, with previous attempts and verification results kept in the task history.
- Detect repeated, unproductive Agent actions and attempt bounded recovery before pausing.
- Select FP16 or Q8 KV cache, save context discovery results and review clearer loading status.
- Choose between Ask for confirmation and Absolute Autopilot.

### Changed

- Agent plans, progress and checks follow their task when you switch conversations.
- Agent timelines, terminal status, long histories, model loading and error messages are clearer.

### Fixed

- Improved Agent recovery guidance, verification freshness, file recovery and managed terminal lifecycle.

### Security

- Linux package setup provisions an enforcing AppArmor policy and dedicated Bubblewrap helper. An administrator must authorize accounts for terminal use; isolation failures stop command execution.

[Release notes (EN)](docs/releases/v0.2.0.md) · [Примечания (RU)](docs/releases/v0.2.0.ru.md) · [GitHub Release](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.2.0) · [amd64 DEB](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/download/v0.2.0/local-ai-desktop_0.2.0_amd64.deb) · [SHA256SUMS](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/download/v0.2.0/SHA256SUMS)

## v0.1.0 — 2026-10-10 — Experimental Alpha (pre-release)

Initial published version for Linux x86_64: local GGUF chat through an external llama.cpp server, Agent coding tasks, project references, planning and tools, context controls, attachments and rich responses. The release was tested on the developer's Ubuntu system; clean-install and broad compatibility were not established.

[Tag](https://github.com/Kushch-Yaroslav/local-ai-desktop/tree/v0.1.0) · [Published releases](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases)

## История на русском

### v0.3.0 — 2026-10-28 — Experimental Alpha (локальная сборка)

#### Добавлено

- Инструменты Chat только для чтения вложений, постоянное хранение источников в рамках беседы, последовательное чтение больших документов и восстановление прогресса после Stop, compaction и перезапуска.
- Улучшения Agent Runtime V2, сохранение состояния задач, восстановление и проверка результатов.
- Browser Workspace с native/live preview, изменяемым и пользовательским размером viewport, визуальными областями и Browser QA.
- Улучшения профилей моделей и обнаружения GGUF, восстановление cold start, настройки контекста, диагностика MTP и Vision.
- Продолжение длинных ответов сегментами с общим бюджетом до 50K токенов и мониторинг контекста в Chat и Agent.

#### Изменено

- После подключения диска Linux повторно обнаруживает модели GGUF. Практические рекомендации по GPU и контексту — в [диагностике производительности](docs/gpu-performance-troubleshooting.md).

#### Известные ограничения

- Эта локально подготовленная Experimental Alpha не опубликована. 50K — бюджет оркестрации: модель может естественно завершить ответ раньше; полноту и повторы в длинном тексте нужно проверять.
- Поддержка и скорость зависят от GGUF, `llama.cpp`, доступной памяти, GPU и размещения projector. Модели и `llama.cpp` устанавливаются отдельно.
- Agent может менять файлы проекта. Изоляция терминала обязательна, но не скрывает все доступные файлы хоста и общую сеть.
- Пакет проверен на текущей Ubuntu; чистая установка и широкая матрица дистрибутивов независимо не проверялись.

[Примечания (RU)](docs/releases/v0.3.0.ru.md) · [Release notes (EN)](docs/releases/v0.3.0.md)

### v0.2.0 — 2026-10-15 — Experimental Alpha (предварительный выпуск)

#### Добавлено

- Продолжение сохранённых задач Agent между чатами с историей попыток и результатами проверок.
- Обнаружение повторяющихся бесполезных действий Agent и ограниченное восстановление перед приостановкой.
- Выбор KV-кэша FP16 или Q8, сохранение результатов поиска контекста и более понятный статус загрузки.
- Режимы «Запрашивать подтверждение» и «Абсолютный автопилот».

#### Изменено

- Планы, прогресс и проверки Agent следуют за задачей при переключении бесед.
- Временная шкала Agent, статус терминала, длинные истории, загрузка модели и сообщения об ошибках стали понятнее.

#### Исправлено

- Улучшены подсказки при восстановлении Agent, актуальность проверок, восстановление файлов и жизненный цикл управляемого терминала.

#### Безопасность

- Установщик Linux-пакета настраивает enforcing-policy AppArmor и отдельный Bubblewrap helper. Администратор разрешает учётным записям использование терминала; если изоляция не работает, команды не запускаются.

[Примечания (RU)](docs/releases/v0.2.0.ru.md) · [Release notes (EN)](docs/releases/v0.2.0.md) · [GitHub Release](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.2.0)

### v0.1.0 — 2026-10-10 — Experimental Alpha (предварительный выпуск)

Первая опубликованная версия для Linux x86_64: локальный чат с GGUF через внешний сервер llama.cpp, задачи Agent по коду, ссылки на проект, планирование и инструменты, настройки контекста, вложения и форматированные ответы. Выпуск проверялся на Ubuntu разработчика; чистая установка и широкая совместимость не подтверждены.

[Тег](https://github.com/Kushch-Yaroslav/local-ai-desktop/tree/v0.1.0) · [Опубликованные выпуски](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases)

Historical release validation records are kept in the [documentation archive](docs/archive/README.md).
