# Documentation / Документация

## Current product documentation / Текущая документация продукта

| Purpose / Назначение | English | Русский |
| --- | --- | --- |
| Short overview, downloads, screenshots / Обзор, загрузки, скриншоты | [README](../README.md) | [README.ru](../README.ru.md) |
| Implemented capabilities and limits / Реализованное и ограничения | [FEATURES](en/FEATURES.md) | [FEATURES](ru/FEATURES.md) |
| UI and workflows / Интерфейс и работа | [USER_GUIDE](en/USER_GUIDE.md) | [USER_GUIDE](ru/USER_GUIDE.md) |
| Installation and setup / Установка и настройка | [GETTING_STARTED](en/GETTING_STARTED.md) | [GETTING_STARTED](ru/GETTING_STARTED.md) |
| Observed model compatibility / Наблюдения по моделям | [MODELS](en/MODELS.md) | [MODELS](ru/MODELS.md) |
| Future only / Только будущее | [ROADMAP](en/ROADMAP.md) | [ROADMAP](ru/ROADMAP.md) |
| Version history / История версий | [CHANGELOG](../CHANGELOG.md) | [CHANGELOG](../CHANGELOG.md) |

## Release status

Статус выпусков.

| Version / Версия | Status / Статус | Record / Документы |
| --- | --- | --- |
| v0.1.0 | Previous published release / Предыдущий опубликованный выпуск | [Published releases / Выпуски](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases) · [Verified history / Подтверждённая история](../CHANGELOG.md) |
| v0.2.0 | Published Experimental Alpha pre-release / Опубликованный предварительный Experimental Alpha | [EN notes and screenshots](releases/v0.2.0.md) · [RU примечания и скриншоты](releases/v0.2.0.ru.md) · [GitHub Release](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.2.0) · [amd64 DEB](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/download/v0.2.0/local-ai-desktop_0.2.0_amd64.deb) · [SHA256SUMS](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/download/v0.2.0/SHA256SUMS) · [Checklist / Условия выпуска](releases/v0.2.0-checklist.md) |

No separate v0.1.0 page or historical screenshot set has been reconstructed. Its concise history is limited to verified release/tag records. / Отдельная страница v0.1.0 и исторический набор скриншотов не реконструировались; краткая история ограничена подтверждёнными release/tag данными.

## Maintenance rules / Правила сопровождения

- Keep README short and version-independent. Put dates, release deltas and test counts in CHANGELOG/release notes, not repeated across product guides. / README — краткий и без привязки к версии; даты, изменения и тестовые числа — в CHANGELOG/release notes.
- Update English and Russian product/release pages together. Shared bilingual index/checklist/changelog files avoid two independently drifting records. / Обновлять EN/RU вместе; общий bilingual index/checklist/changelog исключает расхождение двух записей.
- Current claims need implementation/test evidence. A test file's existence is not a passing result. Separate scripted-provider, real OS, mocked GPU and real-model testing. / Нужны исходники/доказательства; наличие теста не означает pass; различать fixture, OS, mock GPU и real model.
- Release notes are a snapshot against a tag and candidate revision. Update Unreleased until publication; after release, append corrections/new releases rather than rewriting evidence as if it existed earlier. / Unreleased уточняется до публикации; после неё исправления/новые выпуски добавляются явно.
- Put detailed version deltas, evidence and screenshots in `docs/releases/vX.Y.Z.md` and `vX.Y.Z.ru.md`; keep original capture files in `docs/img/releases/vX.Y.Z/`. Both languages share those files. Guides may link to the gallery without embedding it again. Older version images stay with their release; shared illustrative images remain in `docs/img/`. / Подробности версии, evidence и скриншоты — в паре release pages, исходные изображения — в каталоге версии, общем для обеих локалей. Guides ссылаются на галерею без повторного встраивания; старые изображения остаются у своего выпуска, общие иллюстрации — в `docs/img/`.
- Record missing coverage as a gate or limitation, not a completed roadmap item. Keep license/attribution links. Check source and packaged documentation paths separately. / Пробелы — gates/limitations, не готовые функции; сохранять лицензии, отдельно проверять source/package ссылки.

## Updating the next release / Обновление следующего выпуска

For v0.2.1 or v0.3.0, normally add an EN/RU release-note pair and any real captures under the matching image directory, append a concise newest-first CHANGELOG entry and update the release-status table above. Reuse the v0.2.0 checklist as the starting structure for a candidate-specific checklist; close gates only with that candidate's evidence. Keep Unreleased until publication, then record the confirmed date/channel and advance the latest-published status.

Для v0.2.1 или v0.3.0 обычно добавляются EN/RU release notes и реальные снимки в каталог версии, краткая запись CHANGELOG (новые сверху) и обновляется таблица статусов. Checklist v0.2.0 служит основой проверки нового кандидата; gates закрываются только его evidence. До публикации сохраняется Unreleased, после неё записываются подтверждённые дата/канал и новый latest-published.

Update paired FEATURES/USER_GUIDE only when current behavior changes; update GETTING_STARTED, MODELS, ROADMAP or technical references only when their subject changes. README normally stays unchanged unless the product overview, general setup or navigation changes. Patch and minor releases use the same documentation layout; neither requires a landing-page rewrite or invented historical material.

Парные FEATURES/USER_GUIDE обновляются при изменении текущего поведения; GETTING_STARTED, MODELS, ROADMAP и технические справочники — при изменении их предмета. README обычно не меняется, кроме общего обзора продукта, установки или навигации. Patch и minor releases используют одну структуру, без переписывания главной страницы и выдуманных исторических материалов.

## Maintained technical references / Технические справочники

Internal implementation plans, superseded policy variants and temporary investigation diaries have been consolidated into the guides, release notes and these references. Do not use old four-mode permissions or historical installation proposals as current policy. Shared technical references may use one working language; user guides and release notes remain paired EN/RU.

Внутренние планы, устаревшие варианты policy и временные исследования сведены в guides, release notes и справочники ниже. Старые четыре режима и предложения установки не являются текущей политикой. Общие технические справочники могут использовать один рабочий язык; user guides и release notes сохраняют пары EN/RU.

| Reference / Справочник | Why retained / Причина сохранения |
| --- | --- |
| [Sandbox security](apparmor-security-review.md) | Canonical policy/loader threat model; runtime diagnostics link here. / Границы policy/loader и цель ссылки runtime diagnostics. |
| [Installation and acceptance](bwrap-installation-acceptance.md) | Explicit administrator procedure, effective enforcement checks and package gaps. / Административная процедура, реальные проверки защиты и пробелы пакета. |
| [Runtime/workspace architecture](runtime-self-protection.md) | Task ownership, persistence, process handles, evidence and recovery invariants. / Принадлежность задач, сохранение, handles, evidence и восстановление. |
| [October 13 evidence record](noop-loader-validation-2026-10-13.md) | Dated real Qwen/no-op/loader provenance, separate from fixtures and owner-reported later results; not independently rerun. / Происхождение результатов Qwen/no-op/loader, отдельно от fixtures и поздних сообщений владельца; не повторялось независимо. |

Local validation artifacts under `.ai-research/validation` and temporary logs are not release artifacts. Redact user data and pin accepted evidence to the release before distributing it. Older shared screenshots may show earlier controls; version-specific captures are linked from their release notes.

Локальные validation artifacts и временные логи не являются release artifacts. До распространения обезличьте данные и привяжите принятые результаты к выпуску. Общие старые скриншоты могут показывать прежние элементы; снимки версии находятся в её release notes.
