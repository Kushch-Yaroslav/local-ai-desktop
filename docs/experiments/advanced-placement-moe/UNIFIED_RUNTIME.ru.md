# Единый runtime и персональная Qwen

Основной runtime: `runtime/llama/llama-server`, официальный upstream5047748f114564fcf271e6a648f60e2d2eae6264. Независимая сборка из git archive, Release, CUDA sm86, GGML_NATIVE=OFF, vision/mtmd; рецепт `scripts/build-main-llama.py`, pin `resources/llama-runtime.json`. Приложение не запускает исследовательский checkout. CUDA Runtime/cuBLAS поставляются рядом с бинарником, RPATH=$ORIGIN; NVIDIA driver остаётся системным. Целевая платформа — Linux x86_64 с совместимым NVIDIA driver, эта сборка не объявляется универсальной для остальных GPU.

Experimental selector удалён. Старое поле профиля игнорируется; остальные поля сохраняются. Standard/Automatic/Manual используют один global runtime. Известные прежние default paths мигрируются при чтении; явный null/custom backend сохраняется. В новой установленной структуре runtime обнаруживается автоматически через resources/llama, включая Electron Run-as-Node launcher. Auto opt-in только для проверенной Qwen; бюджет и причины fallback видны в UI/actual runtime state. Неподдерживаемые варианты не изображаются доступными.

Manual layers сохраняет реальные индексы, диапазоны/Shift/keyboard, CPU/GPU overrides единым аргументом. Поддержка ограничена проверенными qwen3next/llama и полными single-file GGUF metadata; MoE expert placement независимо от ordinary tensors. В персональном профиле overrides отсутствуют: сохранена benchmark-схема ngl48 + все CPU experts. Shared VRAM estimator учитывает tensor bytes, expert cache, KV и recurrent state, compute/reserve, hardware telemetry. Перед restart параметры проверяются заново.

Большие модели в основном runtime и manual/cache запуски используют systemd user scope: MemoryMax до55GiB (с резервом RAM), MemorySwapMax0, watchdog MemAvailable7GiB и aggregate swap-out32MiB. Никаких swappiness/swapoff/drop_caches изменений. Один большой server за раз. Неподтверждённое глобальное отключение pinned buffers не внедрено.

## Персональный профиль

Изменён существующий `custom:e58faa02-8fe3-4217-9c3d-da322326cedc`, «Qwen3-Coder-Next 80B Q4 — 64K Q8», в source-install `runtime/app-data/runtime-settings.json`.
GGUF: `/media/yaroslav/01D9B3596C5596B0/LINUX-LLM/Qwen3-Coder-Next-80B-Q4/Qwen_Qwen3-Coder-Next-Q4_K_M.gguf`.
Manual cache16384MiB, GPU layers48, CPU MoE all, threads8/8, batch512/ubatch128, context65536, Q8 K/V GPU, flash on, mmap, MTP off. Draft path/file сохранены. Temperature/seed глобально не менялись. Другие модели и чаты не переписаны.

Резервная копия: `runtime/backups/unified-runtime-20261031-212202/runtime-settings.json`; там же rollback.json и исходный профиль. Прежний внешний runtime `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server` не перезаписан. Для rollback после штатной выгрузки модели можно восстановить этот JSON; чтобы отключить read-only migration default path, запускать с `LOCAL_AI_LLAMA_SERVER_PATH=/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`. Резервные копии/БД не входят в commit.

Это профиль существующей source-install (пользовательские ярлыки ведут в репозиторий). Отдельная установленная v0.3.1 в /opt и её XDG-реестр не заменены; в том реестре Qwen80B не обнаружена. Пакет поверх рабочего приложения не устанавливался.

## Доказанные интеграционные результаты

Предыдущий успешный прогон основного runtime сохранён в qwen-summary.json: реальные launches4K и64K, streaming Chat, forced tool call с правильным JSON argument7, restart и Standard fallback, CPU experts/GPU cache allocation подтверждены логами.

| Режим | Context allocation | GPU cache MiB | GPU KV MiB | Выборочный peak GPU MiB | Peak process RSS MiB | Process swap |
|---|---:|---:|---:|---:|---:|---:|
| Manual16GiB |4096|16381.03|51|20075|46855.75|0|
| Manual16GiB |65536|16381.03|816|20923|47452.71|0|
| Standard |65536|0|816|4460|46646.58|0|

GPU peak — device-wide включая desktop/driver; RSS включает file-backed GGUF mappings, не только anonymous RAM. Во всём успешном mmap прогоне новый pswpout=0; minimum MemAvailable53497MiB, memory PSI avg10=0. 64K — allocation, не заполненный64K prompt. Настоящие сохранённые значения проверены в Electron, не демонстрационном профиле; последующая проверка файла подтвердила сохранность без повторной записи.

DIO4K остановлен при32.18MiB нового global swap-out. Два Artemis31B теста также остановлены; --no-host не решил проблему, причина полностью не установлена. Последующая попытка Qwen из извлечённого пакета остановлена watchdog при~38MiB global swap-out; это не PASS большого packaged-MoE прогона. Условия не ослаблялись и попытки не повторялись без изменения условий. Успешный source runtime и packaged runtime имеют одинаковые hashes upstream binary/libraries; package capability/ELF и реальный small Dense CUDA launch проверены отдельно.

Нового сопоставимого performance benchmark нет. Исторические29.07/36.96/46.82/56.25tok/s для0/8/12/16GiB относятся к прежнему A/B4K; не являются измерением новой64K конфигурации. mmap выбран по безопасности вместо исторического DIO.

## Projector и упаковка

Найден и исправлен реальный packaged-start bug: fresh install image-device CPU отклонял готовую text-only модель без projector. Теперь устройство сравнивается только при наличии projector; request ID, fingerprint, model/context/KV/speculative проверки сохранены. Regression tests подтверждают text-only success, configured-projector wrong-device rejection и correct-device success. Реальные vision weights не загружались; проверяется protocol/device validation, а не качество vision.

Новый локальный .deb: `local-cache/unified-package/local-ai-desktop_0.3.1_amd64.deb`. Создан с --publish never, не устанавливался. `scripts/unified-package.test.mjs` проверил извлечение, совпадение runtime manifest/hashes, --moe-cache-mib, отсутствие missing ELF deps и зависимости от /usr/local/cuda, fresh bundled path discovery и настоящий Electron + small Dense manual GPU/CPU placement. PASS. Runtime имеет собственные CUDA и mtmd libraries и license notices; host libcuda не поставляется. Старый package smoke ожидает3предустановленных профиля вместо текущего пустого реестра и не является зелёным; актуальная targeted проверка использует действующий контракт.

TypeScript, lint, production build, runtime-settings/migration, placement unit, projector/controller regression и launcher tests прошли. Rust436pass/1ignored. Широкий результат и список оставшихся красных suite — unified/regression-summary.json; baseline10падений доказательно воспроизведены на b5ee356. Ожидание5control groups исправлено, дальнейший p2-сценарий блокируется disabled MTP fixture. Масштабный рефакторинг browser/QA не выполнялся. Полностью green репозиторий и завершённая проверка больших Dense/packaged Qwen не заявляются.

main, опубликованные assets/v0.3.1, Git tags не изменены; push/merge/release не выполнялись.
