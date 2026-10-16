# Changelog / История выпусков

User instructions are in the [English](docs/en/USER_GUIDE.md) and [Russian](docs/ru/USER_GUIDE.md) guides. This file summarizes changes; it does not replace the guides.

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
