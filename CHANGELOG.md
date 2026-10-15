# Changelog / История выпусков

Release history lives here; current usage is documented in the [English](docs/en/USER_GUIDE.md) and [Russian](docs/ru/USER_GUIDE.md) guides.

История выпусков хранится здесь; текущие сценарии — в [английском](docs/en/USER_GUIDE.md) и [русском](docs/ru/USER_GUIDE.md) руководствах.

## v0.2.0 — 2026-10-15 — Experimental Alpha (pre-release) / Экспериментальная Alpha (предварительный выпуск)

- Agent V2 reliability: task-scoped state/history, evidence freshness and attribution, bounded two-stage loop recovery, permission and lifecycle fixes.
- Two user-facing modes, mandatory terminal isolation and protected-runtime process handling.
- Saved FP16/Q8 context loading, independent discovery status, compact selector and Maximum Context summary.
- File recovery/downloads, clearer diagnostics, Mermaid handling and long-history UX improvements.
- RC2 fixes: explicit Selected/Active context loading, live terminal elapsed time, verified fail-closed migration of the known legacy Bubblewrap helper, and terminal stdin isolation from the runtime control pipe.
- The installed RC2 passed local acceptance with Qwen Agent tasks, recovery from a previously paused loop, cross-chat continuation and package upgrade. This is developer-machine acceptance, not clean-install or broad distro certification.
- RC2 package inspection, extracted application smoke tests, enforcing sandbox checks and disposable Ubuntu 24.04 package-lifecycle checks passed. A clean Ubuntu installation has not been independently verified; see the [detailed notes](docs/releases/v0.2.0.md#validation).

Надёжность Agent V2: состояние и история отдельных задач, свежесть/принадлежность evidence, двухэтапное восстановление циклов, разрешения и lifecycle. Два режима UI, обязательная изоляция терминала и защита runtime. Сохранённые FP16/Q8, раздельные статусы discovery, компактные selector/справка. Восстановление файлов, загрузки, диагностика, Mermaid и длинные истории.
- Исправления RC2: явная загрузка Selected/Active context, live elapsed time терминала, проверенная fail-closed миграция известного старого Bubblewrap helper и отделение stdin терминала от runtime control pipe.
- Установленный RC2 прошёл локальную приёмку с задачами Qwen Agent, восстановлением после ранее приостановленного цикла, продолжением между чатами и обновлением пакета. Это приёмка на машине разработчика, не сертификация clean install или других дистрибутивов.
- Проверки содержимого RC2, извлечённого приложения, enforcing sandbox и lifecycle в disposable Ubuntu 24.04 прошли. Установка на независимую чистую Ubuntu не проверялась; см. [подробные заметки](docs/releases/v0.2.0.ru.md#validation).

[Detailed notes (EN)](docs/releases/v0.2.0.md) · [Подробности (RU)](docs/releases/v0.2.0.ru.md) · [GitHub Release](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.2.0) · [Download amd64 DEB](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/download/v0.2.0/local-ai-desktop_0.2.0_amd64.deb) · [SHA256SUMS](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/download/v0.2.0/SHA256SUMS) · [Checklist / Условия выпуска](docs/releases/v0.2.0-checklist.md)

## v0.1.0 — 2026-10-10 — Experimental Alpha (pre-release)

Initial tagged baseline: Linux desktop Chat/local GGUF inference via external llama.cpp; Rust Agent V2, project references, tools/planning, context compaction/discovery, attachments and Rich Responses. Ubuntu developer-machine package/first-run smoke tests were recorded; clean-OS and broad compatibility were not established.

Первый tagged baseline: Linux Chat/локальный GGUF через внешний llama.cpp, Rust Agent V2, ссылки на проекты, инструменты/планы, компактизация/discovery, вложения и Rich Responses. Записаны smoke-tests пакета/первого запуска на Ubuntu разработчика; чистая ОС и широкая совместимость не подтверждены.

[Tag / Тег](https://github.com/Kushch-Yaroslav/local-ai-desktop/tree/v0.1.0) · [Published releases / Выпуски](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases)
