# GPU-доступ восстановлен

2026-10-30: предыдущий блокер относился к sandbox, не к драйверу хоста.

| Проверка | Обычный exec | require_escalated |
|---|---|---|
| mount namespace | 4026533271 | 4026531832 |
| user namespace | 4026533143 | 4026531837 |
| PID namespace | 4026533273 | 4026531836 |
| /dev/nvidia* | отсутствуют | доступны |
| nvidia-smi | код 9 | RTX 3090, 580.196.07 |
| llama-server --list-devices | none | CUDA0 |

Одинаковый cgroup WebStorm Snap сам по себе не означает одинаковый mount namespace. Обычный exec находится в отдельной изоляции. Штатный exec_command sandbox_permissions=require_escalated прошёл автоматическую проверку и получил доступ к устройствам. nsenter, ручное создание device nodes, sudo, отключение защиты и изменение драйвера не использовались. Изменения режима запуска Codex не понадобились.

Минимальный CUDA test: cudaMalloc 128 bytes, host-to-device, kernel add<<<1,32>>>, synchronize, device-to-host и проверка всех 32 результатов. PASS. Toolkit nvcc 12.6; показанное nvidia-smi CUDA 13.0 описывает возможности драйвера, не версию использованного compiler toolkit.

Host MemAvailable после восстановления доступа: 56,845,357,056 bytes. Git HTTPS работает через разрешённый режим, origin/main = 4fcc6c8890344c13723592323e96fd4eaa721544.

Отдельный официальный checkout: runtime/experimental-llama-moe, commit 5047748f114564fcf271e6a648f60e2d2eae6264. Production checkout /media/yaroslav/DATA/llama.cpp не менялся. CUDA target sm_86, Release, build jobs=6. Используются существующие CMake/Ninja из production .build-venv только как инструменты, без записи туда.

В исходниках expert cache: segmented LRU (probation/protected), CPU-resident routed expert weights, объединение передач, обход cache для больших batches, hits/misses/uploaded MiB в shutdown log. Tensor parallelism не поддерживается. Реальная работа моделей требует отдельных результатов загрузки и generation.

Проверен systemd-run --user --scope -p MemoryMax=55G -p MemorySwapMax=0 /usr/bin/true. Все большие модели следует запускать последовательно внутри такого scope, с мониторингом свободных RAM/VRAM. scripts/moe-cache-experiment.py отказывается от запуска при недоступной GPU и завершает свой server при достижении лимитов. Это экспериментальный runner; application code не менялся.
