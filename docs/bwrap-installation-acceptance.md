# Установка выделенного Bubblewrap helper и приёмка AppArmor

Поддерживаемая техническая процедура для отдельно одобренного тестового
развёртывания текущих исходников на Ubuntu 24.04. Запускайте команды из корня
проверенного checkout под обычной учётной записью приложения. Это не автоматическая
политика установки опубликованного v0.1.0 и не разрешение менять систему.
Сохранённый результат более поздней source-приёмки — в
[записи 13 октября](noop-loader-validation-2026-10-13.md); при очистке документации
он не повторялся. Кандидат v0.2.0 и его пакет всё ещё требуют отдельной приёмки.
Parser и complain-профиль не заменяют enforcing-проверку.

## Проверка перед установкой — без sudo

Из обычного терминала пользователя:

```bash
id
getent group "$(id -gn)"
bash scripts/install-bwrap-apparmor.sh --check
cat assets/apparmor/local-ai-desktop-bwrap
cat scripts/install-bwrap-apparmor.sh
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
cat /proc/sys/kernel/unprivileged_userns_clone
npm run build
node scripts/sandbox-startup-electron.test.mjs --expect-blocked
```

Последняя команда предназначена **только для исходного состояния без установленного
helper**: воспроизводит `setting up uid map: Permission denied` через unconfined
Electron → настоящий RustAgentRuntime → Bubblewrap и проверяет сохранность
изолированных host-процессов. После установки ожидать этот исход не следует.
`npm run build` — сборка исходников для теста, без DEB и установки приложения.

Установщик проверен: attachment — исключительно
`/usr/lib/local-ai-desktop/bwrap`; `/usr/bin/bwrap` только источник копии.
Добавлена проверка против возврата к старому attachment, отказ при существующих
`disable`/`force-complain` записях и обязательная проверка двух enforcing-профилей
в ядре **перед публикацией helper**. Parser запускается с пустым config-file,
без загрузки/записи cache, чтобы локальная настройка parser не включила complain.
Существующая отличающаяся политика или небезопасный helper требуют ручного
разбора; установщик их автоматически не исправляет.

## Единственная команда установки — требует отдельно одобренного sudo

**Не выполнять до явного одобрения установки.**

```bash
sudo /bin/bash scripts/install-bwrap-apparmor.sh --install --group "$(id -gn)"
```

Она создаёт/изменяет:

| Объект | Изменение |
| --- | --- |
| `/usr/lib/local-ai-desktop` | Каталог root:root, 0755 |
| `/usr/lib/local-ai-desktop/bwrap` | Обычная копия distro binary, root:основная-группа-пользователя, 0750; без setuid/setgid |
| `/usr/lib/local-ai-desktop/.bwrap.XXXXXX` | Временная копия; удаляется trap либо атомарно становится helper |
| `/etc/apparmor.d/local-ai-desktop-bwrap` | Файл root:root, 0644, из проверенного asset |
| Kernel AppArmor | Загружает/заменяет `local_ai_desktop_bwrap` и `local_ai_desktop_bwrap_child`, проверяет `(enforce)` |

Не меняются `/usr/bin/bwrap`, vendor-профили, глобальные sysctl, AppArmor service,
модели, caches, пользовательские проекты. Выбранная non-root группа должна уже существовать;
группы и членство не изменяются. При ошибке загрузки/проверки установщик завершится
с ошибкой и не опубликует новую копию helper. Файл политики и уже загруженные
профили могут остаться — это не транзакция с автоматическим rollback. Не
продолжать приёмку и не ослаблять политику автоматически при такой ошибке.

## Проверка установки

Ещё одна команда с sudo — **только чтение** текущих kernel-профилей:

```bash
sudo /usr/bin/grep -E '^local_ai_desktop_bwrap(_child)? \(enforce\)$' /sys/kernel/security/apparmor/profiles
```

Должны присутствовать обе строки. Эта команда ничего не изменяет.
Проверки файлов выполняются без sudo:

```bash
stat -c '%U:%G %a %n' /usr/lib/local-ai-desktop /usr/lib/local-ai-desktop/bwrap /etc/apparmor.d/local-ai-desktop-bwrap
cmp /usr/bin/bwrap /usr/lib/local-ai-desktop/bwrap
cmp assets/apparmor/local-ai-desktop-bwrap /etc/apparmor.d/local-ai-desktop-bwrap
getcap /usr/lib/local-ai-desktop/bwrap
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
cat /proc/sys/kernel/unprivileged_userns_clone
```

`cmp` и `getcap` должны завершиться успешно без вывода; значения sysctl должны
сохраниться такими, какими были до установки. Runtime дополнительно проверяет root-owned
предков, отсутствие symlink/опасных mode bits/file capabilities и SHA-256
совпадение helper с distro binary. После обновления distro Bubblewrap копию
необходимо обновить той же явно одобренной процедурой; устаревший helper
блокирует запуск, без переключения на менее защищённое исполнение.

## Enforcing-mode приёмка — обычный пользователь, без sudo

```bash
npm run test:sandbox-startup:electron
```

Не добавлять `--inherited-label` или `--expect-blocked`: это диагностические
сценарии, не enforcing-mode приёмка. Не запускать тест через sudo.

Тест поднимает отдельный Electron с тем же Chromium sandbox launch helper,
что приложение, и проверяет label main-процесса `unconfined`. Он вызывает
настоящий `RustAgentRuntime.stream` и production terminal executor, а не mock
исполнения shell. Только модельный HTTP provider заменён детерминированным
локальным fixture: реальной Qwen inference нет. Пользовательская запущенная
Electron/llama-сессия не используется. Это integration fixture production
execution path; тест не автоматизирует клики в пользовательском GUI.

Обязательные утверждения:

- `pwd`, `ls`, `echo`, `cat` действительно выполняются.
- Выбранный проект — новый временный каталог `/tmp/lad-unconfined-sandbox-*/workspace`.
  Terminal записывает `generated.txt`, содержимое независимо проверяется host-тестом.
- Python HTTP server запускается через `task_action:start`, подтверждается через
  `status` по непрозрачному task handle, отвечает на реальный GET и останавливается
  через `stop`; после остановки соединение отклоняется.
- Прямой `kill` host fixture PID возвращает `PROTECTED_RUNTIME_PROCESS`.
  Дополнительно native `kill` syscall из sandbox не достигает ни fixture Electron,
  ни отдельного fixture sleep. Оба host-процесса сохраняются; реальные процессы
  пользователя не становятся целями destructive-проверок.
- Payload сохраняет **оба** stacked AppArmor-профиля и mode `(enforce)`.
  Иначе приёмка завершается ошибкой, даже если команды работают.
- UID/GID maps соответствуют пользователю; `NoNewPrivs=1`, `Seccomp=2`,
  permitted/effective/ambient capabilities равны нулю.
- В Absolute Autopilot установлен наблюдающий callback разрешений, который
  отказывает любому неожиданному запросу. Счётчик вызовов и approval UI events
  должны быть нулевыми; защита host-процессов всё равно действует.
- Production executor повторно вызывается **внутри** sandbox. Унаследованные
  seccomp/child profile запрещают новые namespaces. Ожидается структурированный
  отказ `setup_required=true`, `retrySameArguments=false`; marker-файл от команды
  не должен появиться. Это принудительный отказ изоляции без изменения системной
  политики, доказывающий отсутствие fallback в host shell.

При неуспехе enforcing-теста политика ещё не принята. Для диагностики конкретного
интервала теста доступна read-only команда sudo (системные файлы не меняет):

```bash
sudo /usr/bin/journalctl -k --since '10 minutes ago' --no-pager --grep='apparmor="DENIED"'
```

Не использовать `aa-complain`, отключение AppArmor/userns sysctl или shell без
изоляции для достижения зелёного результата. Корректировка candidate возможна
только после разбора конкретных denial и отдельного одобрения повторной загрузки.

## Перезапуск и ограничения

Загрузка политики сама по себе не требует reboot или остановки действующих
Electron/llama: новые terminal executions выбирают helper заново. Если запущенное
приложение использует старую сборку кода, потребуется обычный пользовательский
перезапуск после обновления сборки. Данный тест запускает свежий отдельный
Electron; работающий пользовательский экземпляр он не перезапускает.

Выделенный attachment не затрагивает обычных пользователей `/usr/bin/bwrap`.
Это executable/account scoping, а не аутентификация единственного caller: другие
процессы выбранной группы могут намеренно вызвать частный helper. Подробные
пределы защиты — в [security reference](apparmor-security-review.md). На каждом
целевом хосте нужно проверить stacked transition, setup mount/capability permissions
и networking/project writes именно под enforcing-кандидатом.

## Пакетный release candidate v0.2.0

Эта страница описывает отдельный source installer. Пакетный кандидат использует
`packaging/sandbox-lifecycle.sh`: dpkg conffiles, отдельную системную группу,
проверку enforcing перед публикацией helper, trigger обновления distro binary
и удаление только управляемой копии. Членство разрешает администратор; source
installer и пакетное управление не следует совмещать. Уже загруженные профили
при удалении не выгружаются, чтобы не снять защиту с работающих payloads;
системная группа сохраняется во избежание повторного использования GID.
Глобальные sysctl и чужие профили не меняются. Приёмка clean install/upgrade
на disposable Ubuntu 24.04 остаётся в [checklist](releases/v0.2.0-checklist.md).
