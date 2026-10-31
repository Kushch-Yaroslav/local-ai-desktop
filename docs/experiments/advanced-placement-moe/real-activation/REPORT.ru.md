# Реальные MoE operations: заключительный локальный контроль

## Итог

**B на проверенном операционном охвате:** настоящий dynamic cache не добавляет ошибок относительно static CUDA. CPU/CUDA отличаются на одинаковых реальных inputs; CUDA outputs в этой выборке ближе к отдельному численному oracle. Полная причинная атрибуция model-level logit divergence по всем слоям не выполнена, и универсальная корректность backend не заявляется.

Допустим следующий этап — ограниченная **опциональная экспериментальная интеграция для этой Qwen/сборки**, с Standard fallback, opt-in, feature detection, безопасным VRAM budget и явным отсутствием гарантии CPU-identical answers. Это не разрешение включить Automatic по умолчанию, не подтверждение отсутствия quality regression на широком наборе и не обобщение на другие архитектуры. Ошибка «−2» остаётся наблюдением качества, а не исправленным дефектом backend. UI/production в этой задаче не менялись.

## Захваченные операции

Один24-token запуск точного сохранённого explain prompt. Hash formatted prompt проверен против A/B, первые24output IDs совпали с baseline. Scheduler callback останавливается после выбранного node до переиспользования его memory. Шесть MUL_MAT_ID операций относятся к одному общему prefix: первый incremental decode, step1 после prompt. Inputs F32; binary input/output/IDs и metadata ne/nb/op_params сохранены в fixtures. Общий prefix IDs присутствует в metadata.

- Layer0 gate/up/down: experts319,292,83,446,44,349,354,111,322,284.
- Layer1 gate/up/down: experts15,110,234,326,111,422,164,95,269,265.
- Gate/up input[2048,1,1,1], Q4_K weight[2048,512,512], output[512,10,1,1].
- Down input[512,10,1,1], Q6_K weight[512,2048,512], output[2048,10,1,1].

Исходные quantized GGUF weights не менялись и не коммитились. Каждая локальная операция использует20нужных expert payloads:10real selected и10дополнительных реальных weights для eviction stress. Переключение на эти disjoint control IDs — диагностический stress, не утверждение о реальном router decision. Во всех трёх путях на каждом шаге inputs/IDs/weights/layout/op parameters одинаковы.

## Три пути и результаты

CPU оригинальный quantized tensor; static CUDA тот же tensor без remapping; dynamic CUDA через **настоящий exported llama_moe_cache**: constructor/copy/get_slot_map/get_experts, native SLRU, GET_ROWS lookup, async uploads. Не имитация cache. Metadata-model no_alloc, ngl999 используется только для назначения GPU выбранной fixture; остальные expert pointers убраны из изолированного metadata-object. Полная модель не выделяется на GPU. В original ngl48 layer0 CPU-assigned, поэтому локальная CUDA проверка layer0 — дополнительный контроль оператора, а не тот же full-model placement. Layer1 GPU-assigned в original config.

| Операция | CPU/static CUDA max abs | MAE | RMSE | Relative L2 | Static/cache max abs |
|---|---:|---:|---:|---:|---:|
|blk.0.ffn_gate_exps.weight|0.00928385|0.00119725|0.00183909|0.334%|0|
|blk.0.ffn_up_exps.weight|0.00839260|0.00124780|0.00190001|1.005%|0|
|blk.0.ffn_down_exps.weight|0.00111962|0.00015143|0.00020305|1.253%|0|
|blk.1.ffn_gate_exps.weight|0.01270378|0.00233609|0.00309767|1.072%|0|
|blk.1.ffn_up_exps.weight|0.01151489|0.00227097|0.00299850|1.246%|0|
|blk.1.ffn_down_exps.weight|0.00216575|0.00020359|0.00028625|1.669%|0|

Во всех30состояниях **static/cache bitwise identical**; соответственно CPU/cache errors равны CPU/static errors. Все6CPU replays bitwise identical captured model outputs — проверено, что fixture/веса/layout воспроизводят реальное вычисление. operations.json хранит все3pair metrics, output norms, RMSE, norm-relative L2/Linf и counts выше1e-6/1e-4/1e-3/1e-2; около нуля не используется неустойчивая elementwise division.

## Cache states, bytes и synchronization

Для каждого fixture cache ровно10slots: first miss → hit → disjoint miss/evict → original IDs reuse miss → hit-after-reuse. Native counters каждой операции hits20/misses30, активные slot IDs уникальны. Все выбранные экспертные payloads read-back после outputs побайтово совпали с GGUF CPU weights, то есть проверены не только512-byte samples.

Между native uploads/slot-map copy и graph launch harness НЕ добавляет sync. Используется graph_compute_async в том же backend stream. Sync ставится ПОСЛЕ графа перед чтением outputs. Неправильный read-before-upload в этих случаях дал бы расхождение с static CUDA, которого нет. Это ограниченная проверка, не универсальное доказательство отсутствия async bugs.

При разработке harness был пропущен обязательный output completion wait, что давало stale host metrics после смены IDs. Это исправлено в тестовом harness; upstream/backend bug не обнаружен и не патчился. Не смешивать эту диагностическую ошибку с cache synchronization.

CUDA Compute Sanitizer: memcheck на captured Q4_K gate —0errors; racecheck на captured Q6_K down —0hazards/0warnings. В обоих случаях5cache states и assertions прошли. Racecheck проверяет shared-memory hazards и не исключает все global-memory/cross-stream races. Не тестировалась вся full-model scheduler concurrency, все47cached layers одновременно, все experts, multigpu или другие архитектуры.

## Численное объяснение

Исходники pinned backend: CPU Q4_K/Q6_K dot traits используют Q8_K activation quantization; CUDA mmvq использует Q8_1. Поэтому одинаковые F32 input activations не означают одинаковую внутреннюю integer dot arithmetic. Это обычное различие kernels, не изменение quantization исходных весов.

В ОТДЕЛЬНОМ oracle quantized weight rows деквантируются в float, products с неизменными captured F32 inputs суммируются в double. Он не подменяет основные три quantized пути. На всех6операциях CUDA/cache RMSE к oracle примерно вдвое меньше CPU RMSE (полные числа в operations.json). Это свидетельство против интерпретации «различие CPU/CUDA означает неправильный GPU cache»; не гарантия, что CUDA ответ семантически лучше.

## Минимальный logit control

После локальных проверок выполнены только2однотокенных teacher-forced запроса: один CPU, одинcache16GiB, одинаковые сохранённые prefix IDs для step20. Raw vocab151936, max abs0.363869, MAE0.060116, TV0.031798. CPU выбрал current3231, cache known5278; top2 gaps0.094845/0.016254. Это full-prefix prefill, а не incremental free decoding — направление выбора отличается от прежнего free known→current. Такое различие batching нельзя скрывать или смешивать с ошибкой cache. target20-logits.json содержит top-K/ranks/probabilities.

Локально измеренные CPU/CUDA errors и близкие competing logits объясняют МЕХАНИЗМ чувствительности greedy generation. Но причинная доля каждого MoE/другого op во всём model-level delta не установлена: model path с заменой ровно этих6operations на static CUDA отдельно не выполнялся. Статическое размещение всей45GiB модели в24GiB не пытались делать. Отсутствие дополнительных ошибок cache доказано для проверенных inputs/states, а не для всех inference traces.

Минимальный следующий шаг, только если требуется полная причинная атрибуция: выполнить один teacher prefix с контролируемой заменой выбранного MoE output на static-CUDA reference и сравнить его downstream logits. Не требуется новая80-answer matrix. Это не blocker для инженерного opt-in prototype, но blocker для безусловного заявления «вся разница logits исключительно kernels».

## Ресурсы и regression

Полноразмерные запуски: один короткий capture и дваоднотокенныхteachercontrols, последовательно. Cgroup51GiB/swap0 и прежнийwatchdog. Локальныеreplays/sanitizers —4GiB/swap0, RAM/PSI/swap-out watchdog, VRAM reserve. Во всех full runs/replays новыйswap-out0, OOM0. Swappiness60не менялся; пользовательские процессы не завершались. GPUосвобождена после тестов. Фикстуры~320KBbinary, веса/full-vocab arrays не коммитятся.

validate-results.py проверяет6CPUcapture identities,30static/cache identities, всеmapping/weight checks,6oracle comparisons и2sanitizer summaries. Ранееmetricunit tests также проходят. Новых performance benchmarks нет: ускорение остаётся результатом предыдущейpairedматрицы, instrumentation timings не используются как speedup. Backend fixesне требовались. Production runtime/UI/main/v0.3.1 не менялись, push/merge/release нет.
