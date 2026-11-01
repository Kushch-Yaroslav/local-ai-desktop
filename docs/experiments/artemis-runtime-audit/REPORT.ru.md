# Artemis31B: аудит совместимости runtime

Ветка feature/advanced-placement-moe-acceleration, исходный6718b9b. Профили Artemis/Qwen и GGUF не менялись. Исправления приложения/backend не вносились: подтверждённого дефекта не найдено.

## История

- df8b068: прежние capability profiles Gemma4/Devstral.
- 42e0311: проверенный внешний Gemma MTP assistant, проверки checksum/metadata/shared KV и подтверждение speculative allocation.
- 5880180: намеренное удаление retired builtin Gemma/Devstral с сохранением generic runtime. Это не удаление поддержки custom Artemis.
- d0d5137: исправления чтения документов, quote evidence/delivery receipts; реальная Artemis reading validation.
- beb342f: исправление владения cleanup launcher и восстановления offline-load. Реальные Artemis4K/Q8 и8K/F16CPU lifecycle тесты в launcher audit.

Эти изменения находятся в истории текущей ветки (также integration/v0.3.1/main для поздних исправлений). Документированные успешные чтения использовали old runtime, ngl999, ctx57344, FAon, Q8 K/V GPU, speculative none. Предыдущие остановленные integration probes использовали ngl32/ctx4096 — это другой placement, не воспроизведение прежнего пользовательского запуска.

В /media/yaroslav/DATA/llama.cpp tracked diff отсутствует; только untracked .build-venv. Git/reflog этого checkout содержит clone d1d3c33. В доступных проверенных материалах не найден отдельный потерянный Artemis CUDA/allocator patch. Ограниченная локальная история не доказывает отсутствие любых когда-либо существовавших сторонних патчей.

## Runtime и профиль

Old: /media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server,0.4.1-dev d1d3c33, GNU13.3 Release CUDA, GGML_NATIVE=ON, CUDA architecture явно не задана в cache.
New: runtime/llama/llama-server,0.8.0-dev5047748f114564fcf271e6a648f60e2d2eae6264, GNU13.3 Release CUDA sm86, GGML_NATIVE=OFF, собственные runtime libraries. Оба распознают Gemma4 и загрузили реальную модель. Обе версии предоставляют load-mode/host/repack/lazy controls. Номер версии сам по себе не служит доказательством совместимости.

Настоящий профиль custom:38521674-6a65-4904-97be-4cef4cc9df92: TheDrummer_Artemis-31B-v1.2-Q4_K_M.gguf, полный путь указан в ab.json. Gemma4,60blocks,Dense,Q4_K_M. gpuLayers999, familygemma, MTPoff/speculativenone, projector отсутствует. Profile defaults/advanced не заданы: context/KV наследуются из чата, не равны фиксированному4K теста; threads/batch/load policy наследуют backend/launcher. Исторический запуск подтверждает57344/Q8/GPU. Новых MoE-настроек у Artemis нет. В одинаковых argv A/B отсутствуют --moe-cache-mib, --cpu-moe, speculative drafts и manual tensor overrides.

## Ограниченный A/B

scripts/artemis-runtime-audit.py: один read-only GGUF, ngl32,4096context,Q8 K/V GPU,FAon,mmap,threads8/8,batch512/ubatch128,fitoff,parallel1,безwarmup/MoE/speculation. Temporary port, модели строго последовательно. Outer systemd user cgroup MemoryMax55GiB/MemorySwapMax0; stop при MemAvailable<7GiB или новом global pswpout>32MiB; исходный config byte-for-byte проверен после каждого прогона. Во время загрузки sampled /proc process memory, MemFree/Available/Cached/Anon/Mlocked/Unevictable, swap in/out, PSI и cgroup anon/file/events. Снимки process VmSwap до/после не выявили роста; cgroup swap0. Доступный VRAM перед стартом проверен, placement заранее консервативно оценивался в предыдущем integration test. Actual peak VRAM/отдельные CUDA buffer allocations в этом probe не получены; не подменяем их оценками.

| Runtime | Load s | sampled peak RSS KiB | New pswpout pages | Prefill tok/s | Decode tok/s |
|---|---:|---:|---:|---:|---:|
| old d1d3c33 |14.855|19432084|0|10.846|3.825|
| new5047748 |3.988|19430564|0|10.754|3.605|

Всего6prompt/8output tokens на runtime — smoke, не сравнительный performance benchmark. Старый запуск первым, новый использовал прогретый файловый cache: разница load time не доказывает ускорение нового backend. Численное отличие скорости на восьми токенах не доказывает деградацию. Данные всех sampled counters: ab.json. В текущем A/B PSI some/full avg10=0.00; роста VmSwap наблюдаемых процессов нет. Исходный и итоговый config не изменились.

## Что известно о прежнем swap-out

В сохранённых новых-runtime пробах final pswpout delta45828 и46161pages (около179.0 и180.3MiB), при MemAvailable около54GiB. Второй запуск имел --no-host, но тоже остановлен. Эти артефакты сохраняют global counters, а не полноценные process/cgroup snapshots, поэтому невозможно ретроспективно назвать процессы, использовавшие swap. MemorySwapMax0 запрещает swap именно тестового cgroup; global pswpout может принадлежать другим процессам. Это разные показатели.

Высокий MemAvailable включает reclaimable file cache и не равен MemFree. mmap file mappings/RSS не равны private anonymous working set. Наиболее правдоподобная гипотеза — зависимая от текущего состояния RAM/cache политика reclaim при swappiness60 и возможных временных host/repack allocations, а не MoE cache в Dense. Причинность этой гипотезы не доказана; pinned memory как единственная причина не подтверждается --no-host тестом. Нельзя утверждать, что старый runtime точно вызывал тот же swap-out: в новом A/B оба дали0, а старые успешные логи не содержат полного swap-monitoring.

Итог: memory regression нового runtime не подтверждена; не доказано и утверждение, что watchdog лишь обнаружил именно прежнюю проблему. Воспроизведение зависит от отсутствующих исторических условий. Достаточного основания для backend/model-specific patch нет.

Безопасные варианты при повторении: оставить watchdog, выбирать заранее проверенный меньший контекст/GPU budget, сопоставлять process swap/global swap и cold/warm file residency, не использовать swappiness/drop_caches/повторные загрузки как обход проверки. Глобальное отключение pinned/repack без измерений не внедрять. Для окончательного attribution нужен один sampled failure с process/cgroup counters, не новая длинная матрица.

Qwen16GiB/64K профиль не изменён; targeted placement/arguments unit tests прошли, runtime и launcher не менялись. Большая Qwen не запускалась. Sysctl60 не менялся, пользовательские процессы не завершались. Push/merge/tag/release отсутствуют.
