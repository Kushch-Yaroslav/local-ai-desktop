# Экспериментальная интеграция placement / MoE / VRAM

Дата: 2026-10-31. Ветка `feature/advanced-placement-moe-acceleration`.
Production llama.cpp и версия 0.3.1 не заменяются. Экспериментальный runtime выбирается отдельно в профиле и используется только новыми opt-in режимами. GGUF, пользовательские профили и чаты не изменялись: Electron-тесты использовали отдельные каталоги `/tmp/lad-placement-electron-*`.

## Реализация

В существующий ModelProfileEditor встроен ModelPlacement: автоматическое чтение архитектуры/квантования/реальных блоков и тензоров, компактная сетка, отдельный выбор, Shift+click, стрелки клавиатуры, ввод несмежных диапазонов, All CPU, Select all GPU, Reset to Standard. Для Qwen автоматически показаны 48 блоков; синтетическая Dense-модель имеет 4 блока. Метаданные читаются ограниченным GGUF-reader без чтения весов.

Standard сохраняет прежний GPU layer count и runtime. Новые поля optional; старые профили не мигрируют context/KV/GPU layers. При создании настроек для встроенного профиля сохраняется наследование его прежних placement args. Профили с уже заданными advanced settings сохраняют эти настройки.

Ручной выбор компилируется в единый `--override-tensor` с regex реальных `blk.N.*`: выбранные блоки CUDA0, остальные CPU, общие внеблочные веса CPU. `--n-gpu-layers` задаёт GPU execution/KV policy; реальное размещение **весов** определяют overrides. Оно не означает, что все вычисления блока гарантированно выполняются на CPU/GPU. CPU_Mapped и CUDA_Host являются host memory. С активным CPU MoE или ускорением выбор управляет неэкспертными весами, а эксперты остаются на CPU; UI объясняет исключение. KV размещается независимо.

Ручной режим ограничен проверенными архитектурами qwen3next/llama, полными single-file metadata и CUDA0 backend с официальными флагами. Для split GGUF и неизвестных quant types безопасная оценка пока недоступна, ручной режим отключён. Custom tensor rules нельзя совмещать с новым manual/cache режимом. Dense FFN first-N также нельзя совмещать с выбором блоков.

MoE: Standard (по умолчанию), Automatic, Manual; быстрые бюджеты 2/4/8/12/16 GiB. Cache opt-in доступен только Qwen3-Coder-Next: architecture qwen3next,48 blocks,512 experts,Q4_K_M. Automatic дополнительно требует проверенную версию5047748, иначе возвращается в Standard. Нет обещания универсального ускорения. Для других MoE функция не изображается поддерживаемой.

Новый runtime не копируется поверх production. Профиль выбирает существующий `runtime/experimental-llama-moe/build/bin/llama-server` или явный абсолютный путь. Проверяются --help, --list-devices, --version и identity исполняемого файла. На загрузке дополнительно требуется фактическая положительная MoE cache allocation в логе. Передаются `--cpu-moe --moe-cache-mib N --no-host --no-repack --lazy-mode off`; mmap используется по умолчанию, если load policy явно не задана. Стандартные профили не получают новых флагов. Новые режимы ограничивают batch512/ubatch128. MTP и projector с новым бюджетом отклоняются: их память не аттестована.

## Общий бюджет

`src/shared/model-memory.ts` суммирует реальные bytes каждого GGUF tensor, учитывая IDs, отдельные routed experts и CPU MoE. Дополнительно считает KV по heads/key/value/full-attention blocks, precision и context. Для Qwen hybrid учитываются 12 full-attention blocks и 36 recurrent blocks, а не48 обычных KV layers. Recurrent allowance консервативно калиброван для этой модели. Compute allowance1536MiB, VRAM reserve2048MiB. RAM: CPU weights + CPU KV +9216MiB резерва/рабочих буферов.

Один расчёт используется UI, сохранением профиля и preflight launcher с фактическими настройками чата. Изменение context/KV/cache/IDs сразу обновляет диаграмму. За безопасным бюджетом следит launcher, не меняя пользовательские настройки. Доступная память берётся из telemetry; при restart учитывается освобождаемая память только проверенного owned server. Недостоверные metadata/telemetry блокируют новые режимы. Оценка не является точным измерением.

Estimated bar: weights/cache/KV+state/compute/reserve/other apps/free. Actual отдельно показывает allocations из owned-server logs, **не peak RSS и не физическую суммарную VRAM**. В парсере исправлено удаление одинаковых строк: повторяющиеся CPU_Mapped buffers должны суммироваться даже при одинаковом timestamp. Hit rate UI не выдумывает.

## Реальные проверки

Electron / Playwright / preload / IPC / launcher, отдельные SQLite и профили. Dense fixture: настоящая inference на искусственных нулевых F32 весах; это тест размещения/протокола, не качества модели.

- UI: реальные4/48 блоков, single/range/noncontiguous/all/reset, invalid range, keyboard, сохранение и повторный запуск Electron, пересчёт hybrid64K.
- Dense CUDA: реальные CUDA0 для блоков0/2 и host для1/3, Streaming Chat и отмена.
- Qwen Standard, старый runtime: загрузка4K/Q8 и короткий прямой chat request.
- Qwen cache8GiB: restart на экспериментальный runtime,16K/Q8, настоящий Streaming Chat с системным prompt приложения и16tool schemas. Обработано5295prompt tokens; ответ завершился. Факт вызова инструмента этим smoke не проверялся.
- Qwen cache12GiB + manual: GPU обычные веса всех блоков кроме2, experts CPU,64K/Q8; native log подтверждает blk.1.attn_qkv CUDA0, blk.2.attn_qkv CPU и ffn_up_exps CPU. Возврат Standard возвращает первоначальный runtime,64K загрузка без cache проходит.

| Qwen configuration | GPU weights MiB | Expert cache MiB | GPU KV MiB | GPU compute MiB | CPU model mappings MiB |
|---|---:|---:|---:|---:|---:|
| Standard4K | 1626.23 | — | 51 | 846.26 | 46220.12 |
| Cache8GiB,16K | 1626.23 | 8190.52 | 204 | 850.50 | 44838.39 |
| Manual + cache12GiB,64K | 1382.80 | 12286.17 | 816 | 461.00 | 45081.83 |
| Standard restored,64K | 1626.23 | — | 816 | 861.26 | 46220.12 |

Таблица — allocations/mappings, не RSS. Предыдущий8GiB JSON содержит старую заниженную сумму CPU mappings; исправленный parser даёт44838.39MiB из сохранённого лога. Expert cache / KV значения не затронуты.

Во всех тяжёлых прогонах: systemd cgroup MemoryMax55G/MemorySwapMax0, memory watchdog, RAM reserve7GiB, остановка при новом aggregate swap-out>32MiB. vm.swappiness оставался60.

Две DIO-попытки остановлены watchdog:123.15MiB и96.16MiB нового общесистемного swap-out; тесты не продолжались с ослабленной защитой. mmap/cache8 прогон:0 новых swap-out pages, минимум MemAvailable54524MiB.64K/cache12 прогон:0 новых swap-out pages, минимум54813MiB. Это системная доступная память с учётом reclaimable file cache, **не свободные физические страницы**. Профиль с почти всеми ordinary weights на CPU был отклонён RAM budget; выбранное совместное размещение прошло без изменения лимитов.

64K здесь означает allocation, не заполненный64K prompt. Для4K короткий HTTP chat проходит; системный prompt и tool schemas приложения (~5295tokens) не помещаются в4K и дают штатный context-full. Streaming Chat проверен при16K. Полного long-context quality benchmark не было.

Исторический A/B прежней исследовательской серии:0/8/12/16GiB =29.07/36.96/46.82/56.25 decode tok/s (+93.5% при16GiB). Это не новый benchmark интеграции. Текущий8GiB smoke: prefill80.66tok/s, decode24.01tok/s всего на2output tokens; такую короткую генерацию нельзя считать сравнительным измерением скорости. Telemetry8GiB: short ubatch hit48.13%, large ubatch11.24%; это один mixed-prefill run, не универсальный hit rate.

## Проверки и ограничения

Production build (Rust build + TypeScript + Vite + main tsc), lint, новые placement unit tests, profile metadata/persistence/compatibility, GGUF readers, backend tests, launcher recovery/overlap/idle/failure прошли. Rust host tests:436pass,1ignored. Реальный Electron UI/Dense smoke и совместный Qwen64K прогон прошли. Cache8GiB/streaming stage прошёл; его более длинный сценарий затем штатно остановился на отклонении небезопасного RAM placement (сохранён исходный FAILED artifact, он не переименован вPASS).

Широкий existing regression aggregator:31suite passed,10failed; `integration/regression-summary.json` содержит список. Падения UI/browser сценариев (selector timeouts; MTP expected auto vs off) не устранены и не объявляются проверенными доработкой. Их предшествование этому изменению не доказано. Поэтому весь репозиторий не заявляется полностью green.

Не выпускался .deb и не проверялся bundling экспериментального runtime в установочный пакет: runtime остаётся внешним opt-in executable. Нет нового релиза/тега/push/merge. GPT-OSS, MTP и новая A/B quality матрица не запускались. Ограничения CPU/CUDA arithmetic и охват cache correctness из предыдущего отчёта сохраняются. Это экспериментальная интеграция, не глобальное включение и не гарантия одинаковых ответов.

Воспроизведение: `npm run build`; `node dist/main/models/model-placement.test.js`; создание `/tmp/placement-dense.gguf` через `scripts/create-placement-dense-fixture.py SOURCE_QWEN OUTPUT`; `node scripts/placement-electron.test.mjs` в разрешённом desktop окружении. GPU scope: `systemd-run --user --scope -p MemoryMax=55G -p MemorySwapMax=0 timeout 900 env LOCAL_AI_PLACEMENT_GPU_TEST=1 node scripts/placement-electron.test.mjs`. Только Qwen, последовательно; никаких sysctl изменений.
