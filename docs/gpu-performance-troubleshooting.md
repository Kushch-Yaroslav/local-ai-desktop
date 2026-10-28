# GPU performance and headroom

[English](gpu-performance-troubleshooting.md) · [Русский](gpu-performance-troubleshooting.md#диагностика-18-октября-2026)

## Practical guidance

- Treat the largest context that loaded once as a ceiling, not a comfortable everyday setting. Longer contexts increase KV-cache memory and prompt-processing work. The actual fit also depends on the model weights, KV format, MTP configuration, projector, GPU offload, backend buffers and other applications using the GPU. Use a measured, repeatable profile and leave memory headroom for the desktop and other GPU clients; no fixed reserve is safe for every model.
- FP16 KV cache generally takes more memory than Q8. Q8 can make a larger context fit, but compare output quality and speed for the workload rather than assuming it is free or universally better.
- MTP has its own model/backend requirements and may add weights or buffers. It can change memory use and token throughput. A slowdown observed while MTP is enabled does not by itself establish that MTP caused it; compare otherwise identical runs after the machine returns to a stable baseline.
- Browser Vision cost depends on the model, projector, image dimensions, encoding and device placement. A CPU projector uses host CPU/RAM and avoids projector GPU allocation but may add latency. A GPU projector may reduce CPU work while consuming scarce VRAM and competing with model inference. Follow the effective device in the model/runtime startup diagnostics; a requested `auto` preference alone does not prove where it ran.
- Capture only useful browser frames. Larger images take longer to capture, encode, transfer and analyze, and can use more context. Continuous display streaming and selective images sent to a model are different workloads.
- GPU utilization is not a percentage of the board's power limit. It reports activity in monitored GPU engines over a sampling interval. Check SM and memory-controller activity, power, clocks, temperature, throttling, process attribution and compute-process allocations together. A graphics process can keep SM activity high without a large CUDA allocation; low VRAM does not mean the GPU is idle.

For a read-only Linux snapshot, `nvidia-smi` can report device state, while `pmon` and `dmon` show short per-process and device samples. Compare them with the application's model-server process list. Process names and engine attribution are evidence of a workload, not proof of which browser tab or page caused it. Do not terminate a process or reset the GPU as a diagnostic shortcut.

## System observation — 18 October 2026

At 16:32 UTC, after Local AI Desktop had been closed, the RTX 3090 still showed 97% GPU utilization, 1% memory-controller utilization, 910 MiB of 24576 MiB framebuffer memory, 181.54 W of a 370 W power limit, 62 °C, P0, 1950 MHz graphics clock and 9751 MHz memory clock. The PCIe link was Gen 4 x16. The active throttle-reason mask was zero. The earlier reported 23.6 GiB allocation during model use was not independently measured in this post-close snapshot.

Eight consecutive one-second `nvidia-smi dmon` samples showed 94–100% SM, 1–2% memory-controller utilization, 898–912 MiB framebuffer memory and 181 W. Across a 15-sample per-process poll, Chrome's GPU process (PID 3388) was the only sustained high-SM client, generally at 97–98% and later at 84–86%; it is a graphics (`G`) process with about 212–243 MiB reported framebuffer allocation. Xorg, GNOME Shell, WebStorm/JCEF, Nautilus and Telegram had small graphics allocations. `nvidia-smi --query-compute-apps` returned no CUDA compute processes. No `llama-server`, Local AI Desktop or Electron process was present in the NVIDIA process list; PIDs in the local runtime snapshot had already exited. Host CPU, memory and I/O PSI showed no significant current pressure.

The kernel journal query for NVIDIA/Xid/DRM faults in the preceding two hours found only the normal DMA-address initialization line and no Xid or GPU fault. These observations support a live graphics workload attributed by NVIDIA to Chrome, not a lingering Local AI Desktop CUDA inference allocation. They do not identify the responsible Chrome tab, prove a driver defect, or establish that the same Chrome workload caused the earlier Electron input delay or inference slowdown. GPU utilization did not return to idle during this observation, so isolated application performance tests would have been confounded and were not run. No processes were stopped and no system settings were changed.

### Captured commands

```sh
nvidia-smi --query-gpu=name,driver_version,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,power.limit,temperature.gpu,clocks.gr,clocks.mem,clocks_throttle_reasons.active,pcie.link.gen.current,pcie.link.width.current --format=csv
nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv
nvidia-smi pmon -c 15 -s um
nvidia-smi dmon -s pucvmt -c 8
journalctl -k -b --since '2 hours ago' --no-pager | rg -i 'NVRM|nvidia|Xid|drm|fallen off|GPU fault'
cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io
```

## Практические рекомендации

- Считайте максимальный однажды загруженный контекст верхней границей, а не комфортным ежедневным значением. Больший контекст увеличивает память KV-кэша и затраты на обработку prompt. Фактическое потребление также зависит от весов модели, формата KV, MTP, projector, GPU offload, буферов backend и других приложений. Используйте измеренный повторяемый профиль и оставляйте запас для рабочего стола и других GPU-клиентов; универсального безопасного размера запаса нет.
- KV-кэш FP16 обычно занимает больше памяти, чем Q8. Q8 может позволить загрузить больший контекст, но скорость и качество следует сравнивать на своих задачах.
- У MTP есть требования к модели и backend; оно может добавлять веса или буферы. Это влияет на память и скорость генерации, но одно совпадение по времени не доказывает, что именно MTP вызвало замедление. Сравнивайте одинаковые конфигурации после стабилизации нагрузки системы.
- Затраты Browser Vision зависят от модели, projector, размера изображения, кодирования и устройства выполнения. CPU projector использует процессор и RAM, не занимая под себя VRAM, но может увеличить задержку. GPU projector может снизить нагрузку CPU, одновременно занимая VRAM и конкурируя с инференсом. Проверяйте фактическое устройство в диагностике запуска модели/runtime: выбранное `auto` само по себе его не подтверждает.
- Снимайте только полезные кадры браузера. Большие изображения дольше захватывать, кодировать, передавать и анализировать; они также могут занимать больше контекста. Непрерывная трансляция экрана и выборочные изображения для модели — разные нагрузки.
- GPU utilization — не процент лимита мощности платы. Это активность измеряемых GPU-движков за интервал наблюдения. Сопоставляйте SM и memory-controller, мощность, частоты, температуру, причины throttling, процессы и CUDA allocations. Графический процесс может поддерживать высокую активность SM без большой CUDA allocation; низкое использование VRAM не означает простой GPU.

Для безопасного снимка состояния Linux используйте `nvidia-smi`, а для коротких выборок по процессам и устройству — `pmon` и `dmon`. Сопоставьте их со списком процессов model server. Атрибуция процесса подтверждает нагрузку, но сама по себе не указывает, какая вкладка или страница браузера её вызвала. Не завершайте процессы и не сбрасывайте GPU в качестве диагностического шага.

### Наблюдение системы — 18 октября 2026

В 16:32 UTC, после закрытия Local AI Desktop, RTX 3090 продолжала показывать 97% GPU utilization, 1% загрузки memory-controller, 910 MiB из 24576 MiB framebuffer memory, 181,54 W при лимите 370 W, 62 °C, P0, частоты 1950 MHz по графике и 9751 MHz по памяти. PCIe работал в режиме Gen 4 x16. Маска активных причин throttling была нулевой. Ранее сообщавшиеся 23,6 GiB при работе модели независимо не измерялись в этом снимке после закрытия приложения.

В восьми последовательных секундных выборках `nvidia-smi dmon` SM составлял 94–100%, memory-controller — 1–2%, framebuffer — 898–912 MiB, мощность — 181 W. В 15 выборках `pmon` Chrome GPU process (PID 3388) был единственным процессом с устойчивой высокой загрузкой SM: обычно 97–98%, затем 84–86%. Это графический (`G`) процесс с reported allocation около 212–243 MiB. У Xorg, GNOME Shell, WebStorm/JCEF, Nautilus и Telegram были небольшие графические allocations. `nvidia-smi --query-compute-apps` не обнаружил CUDA compute-процессов. В NVIDIA process list не было `llama-server`, Local AI Desktop или Electron; PID из локального runtime snapshot уже завершились. Host CPU, memory и I/O PSI не показали значимого текущего давления.

Эти данные указывают на продолжающуюся графическую нагрузку, атрибутированную NVIDIA процессу Chrome, а не на оставшуюся CUDA allocation инференса Local AI Desktop. Они не устанавливают, какая вкладка Chrome отвечает за нагрузку, не доказывают дефект драйвера и не подтверждают, что та же нагрузка вызвала прежние задержки ввода Electron или скорость инференса. Во время наблюдения GPU не вернулся в idle, поэтому изолированные тесты приложения были бы загрязнены внешней нагрузкой и не запускались. Процессы не завершались, системные настройки не менялись.
