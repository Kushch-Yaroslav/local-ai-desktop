# Временная swappiness session

2026-10-31: исходное фактическое значение60 прочитано до действий. Разрешение пользователя получено. Административный доступ отсутствует: sudo -n требует пароль; штатный pkexec/systemd-run запрос завершился по timeout90s (exit124) без авторизации. Контроллер не стартовал, sysctl не менялся, повторное чтение подтвердило60. Новые тяжёлые тесты не запускались.

Подготовлен scripts/moe-swappiness-session.py: root controller сохраняет фактическое исходное значение в JSON до записи0, проверяет0, ждёт stop-файл или максимум600s. В finally восстанавливает и перечитывает значение, записывает restored/status. SIGTERM/SIGINT/SIGHUP вызывают cleanup. Повторные сигналы в cleanup игнорируются. SIGKILL, kernel crash и аппаратное отключение не могут быть обработаны Python finally; абсолютной гарантии восстановления при них нет. Отдельный systemd service переживает завершение Codex и имеет RuntimeMaxSec660 и TimeoutStopSec30.

Три unit tests с временным файлом вместо sysctl: normal, timeout и cancellation восстанавливают нестандартное исходное значение37. Тесты не меняют реальный sysctl. Application code и production runtime не менялись.

Для локального запуска пользователем (потребуется стандартная административная авторизация):

```bash
sudo systemd-run --unit=local-ai-moe-swappiness-session --property=RuntimeMaxSec=660 --property=TimeoutStopSec=30 /usr/bin/python3 /media/yaroslav/DATA/local-ai-desktop/scripts/moe-swappiness-session.py /media/yaroslav/DATA/local-ai-desktop/runtime/moe-swappiness-session.json /media/yaroslav/DATA/local-ai-desktop/runtime/moe-swappiness-session.stop
```

До запуска убедиться, что stop-файл от предыдущей сессии отсутствует. В текущей попытке он не создавался. Сразу после авторизации сообщить агенту для старта bounded GPT baseline (менее600s). Для окончания агент создаёт runtime/moe-swappiness-session.stop, ждёт status restored и перечитывает /proc/sys/vm/swappiness. Альтернатива ручной остановки: sudo systemctl stop local-ai-moe-swappiness-session.service, затем проверить JSON и sysctl. При повторном запуске завершённого service может понадобиться другое уникальное имя unit; не запускать два контроллера одновременно.

Следующий GPU-прогон остаётся внутри MemoryMax51G/MemorySwapMax0 с watchdog aggregate swap-out32MiB, net growth128MiB, MemAvailable reserve7GiB и PSI. Экспертный cache и Qwen только после безопасного GPT baseline. Swapoff/drop_caches и постоянные sysctl конфигурации не применяются.
