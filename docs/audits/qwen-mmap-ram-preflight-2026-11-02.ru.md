# RAM preflight Qwen mmap: ложный hard-stop

Исходный HEAD `013e5c3`. Ложный отказ зарегистрирован 2026-11-02 15:44:10.882 UTC,
request `13d05434-42b6-4807-b996-48409d9cdd9e`, offline server. Источник:
`src/main/services/model-placement.ts`, `resolvePlacement`. Проверка существовала
до изменения swap policy (`git log`: 163445d/6718b9b); commit 013e5c3 её не менял.

## Числовое воспроизведение

Сам старый отказ не сохранял числовую разбивку. Ниже **точный повторный снимок
15:47:29.734 UTC**, а не выдуманные показатели в момент 15:44:10:

| Показатель | Значение |
| --- | ---: |
| MemTotal | 67 321 835 520 bytes |
| MemAvailable | 56 464 150 528 bytes = 53 864.2265625 MiB |
| Cached | 54 217 359 360 bytes |
| AnonPages (система) | 8 245 571 584 bytes |
| GGUF tensor bytes | 48 721 691 648 bytes |
| CPU weights estimate | 46 983 462 912 bytes = 44 806.921875 MiB |
| GPU weights estimate | 1657.7041015625 MiB |
| CPU KV | 0 MiB (KV на GPU) |
| Старый фиксированный runtime/OS reserve | 9216 MiB = 9 GiB |
| Старое требование | 54 022.921875 MiB = 56 647 139 328 bytes |
| Превышение доступной RAM | 166 404 096 bytes = 158.6953125 MiB |
| Model cgroup MemoryMax | 56 320 MiB = 59 055 800 320 bytes |
| MemorySwapMax | 0 |

Старая формула: `cpuWeightsMiB + cpuKvMiB + 9216 > availableRamMiB`.
Здесь нет ошибки преобразования GB/GiB: hardware читает MemAvailable kB × 1024,
затем estimator делит bytes на 1024². Например, 55.6 GB = 51.78 GiB, не 55.6 GiB.
Нет доказанного арифметического удвоения весов; проблема — требование полного
одновременного residency для file-backed mmap weights как обязательной памяти.
RSS тоже нельзя приравнивать к anonymous allocations.

## Исправление

Единый `estimateHostMemory` используется preflight и UI. Разделены:
file-backed weights, anonymous weights, CPU KV, state upper bound,
runtime headroom, OS reserve, full resident working set и cgroup capacity.

File-backed режим сертифицируется только для explicit mmap (либо фактического
mmap default cache-режима) с bounded placement, где launcher уже передаёт
`--no-repack --no-host`. Auto/неизвестная политика и потенциальный repacking
сохраняют консервативную оценку anonymous weights. Новых runtime flags нет.
Это общее правило размещения, а не исключение по имени Qwen.

- Mandatory = anonymous weights + CPU KV + state upper bound + 2048 MiB runtime headroom.
- Host hard-check = Mandatory + 7168 MiB OS reserve <= MemAvailable.
- Cgroup hard-check = Mandatory <= model MemoryMax; OS reserve не вычитается повторно внутри scope.
- Full working set = Mandatory + file-backed weights. Если он с OS reserve
  не помещается в RAM или сам превышает scope capacity — предупреждение о
  paging/замедлении, а не утверждение, что все веса обязаны быть anonymous.
- Веса требуют физических страниц при обращении; mmap не делает их бесплатными.
  Не обещается, что модель любого размера будет быстрой или полностью resident.
- Недостаточные mandatory allocations блокируются с числовой разбивкой, включая
  доступную RAM и MemoryMax. Недоступная RAM-телеметрия не сертифицируется.

Для этого профиля новая оценка: file-backed 44806.92 MiB, anonymous weights 0,
CPU KV 0, state upper bound 75.384 MiB, runtime headroom 2048 MiB,
Mandatory 2123.384 MiB, с OS reserve 9291.384 MiB. Полный целевой working set
46930.305875 MiB; с OS reserve 54098.305875 MiB. В повторном исходном снимке
полный working set с резервом не помещается: выводится предупреждение.
Новая оценка не трактует это как доказанный OOM.

MemAvailable уже учитывает reclaimable cache. Owned-process reload credit
по-прежнему даётся только RssAnon, а не всему RSS/file mappings. После unload
preflight заново читает RAM, старое отклонение не кэшируется.

## Реальная проверка

Один запуск настоящего Electron + основного llama-server, unchanged копия
существующего профиля `custom:e58faa02-8fe3-4217-9c3d-da322326cedc`
в `/tmp/lad-ram-preflight-vbGgr4`. Личный runtime-settings.json и чаты не менялись.

- 48 GPU layers, CPU MoE all, cache 16384 MiB, mmap, 65536 context,
  Q8 K/V на GPU, MTP off; значения сохранены и показаны в UI.
- Backend ready, cache allocation 16381.03 MiB, GPU KV 816 MiB.
- Короткая генерация: 15 input tokens, 2 output tokens, завершена успешно.
- Выборочные пики: GPU device-wide 21056 MiB; RSS 46868.67 MiB;
  RssFile 46407.65 MiB; RssAnon 426.92 MiB; model cgroup current 2119.35 MiB.
- Cgroup MemoryMax 59055800320 bytes, MemorySwapMax=0, process swap=0;
  memory.events max/oom/oom_kill=0.
- Низкий cgroup.current относительно RSS не означает, что 45 GiB физически
  бесплатны: shared cached pages могут быть charged другому cgroup при first touch.
- Новый глобальный swap-out 270 страниц × 4096 = 1.0546875 MiB — только диагностика.
- Тестовая модель выгружена. Это 64K **allocation**, не заполненный 64K prompt
  и не повтор performance benchmark/длительного Agent workflow.

## Проверки

- TypeScript + production build, lint — проходят.
- Placement/host tests: offline mmap; CPU experts+cache16+64K Q8 GPU KV;
  bytes/GB/GiB; file-backed vs anonymous/repack/auto; low RAM; большой CPU KV;
  cgroup insufficient/exact mandatory boundary; reserve вне scope; unload/retry.
- Launcher recovery/identity/overlap/idle/failure, memory watchdog и lifecycle — проходят.
- Настоящий Electron с mock RAM: warning при 50000 MiB, hard error с разбивкой
  при 8000 MiB, reload и сохранность профиля — проходят. Без загрузки модели.
- Исходный файл профилей проверен SHA-256 до/после. vm.swappiness=60,
  системный swap, cgroup/VRAM/watchdog protections не ослаблялись.
- Rust source не менялся; повтор полного Rust suite не требовался.

Оценка runtime headroom остаётся оценкой, а не верхним пределом растущего
prompt cache или Agent history. Реальное давление продолжают контролировать
launcher и cgroup. При недоступных/неподдерживаемых metadata прежний VRAM
preflight остаётся блокирующим. Безопасность произвольного длинного workload
не выводится из короткого load smoke.
