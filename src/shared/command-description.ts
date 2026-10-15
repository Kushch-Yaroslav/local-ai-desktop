import { t, tr } from './locale';

export interface CommandDescription { title: string; description: string; destructive?: boolean }
interface ShellList { stages: string[][]; conditional: boolean }

/** Presentation lexer, never an authorization parser. Unsupported shell grammar
 * remains opaque. Quotes, escaped operators and continuations are data. */
export function describeShellWords(source: string): ShellList | null {
  if (source.length > 32_768) return null;
  const stages: string[][] = [];
  let words: string[] = [], word = '', started = false, quote = '', conditional = false;
  const flush = () => { if (started) words.push(word); word = ''; started = false; };
  const stage = () => { flush(); if (!words.length) return false; stages.push(words); words = []; return true; };
  let afterOperator = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote === "'") { if (ch === "'") quote = ''; else word += ch; continue; }
    if (ch === '\\') {
      const next = source[++i]; if (next === undefined) return null;
      if (next === '\n') continue;
      // Inside double quotes bash preserves backslashes before ordinary characters.
      word += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
      started = true; afterOperator = false; continue;
    }
    if (ch === '$' || ch === '`') return null;
    if (quote === '"') { if (ch === '"') quote = ''; else word += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; started = true; afterOperator = false; continue; }
    if (/[<>(){}]/.test(ch) || ch === '#' && !started) return null;
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') {
      if (ch === '\n' && !started && !words.length) continue;
      if (ch === '&' && source[i + 1] !== '&') return null;
      const op = ch === '&' || ch === '|' && source[i + 1] === '|' ? source.slice(i, i + 2) : ch;
      if (op.length === 2) i++;
      if (!stage()) return null;
      conditional ||= op === '||'; afterOperator = op !== ';' && op !== '\n';
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    word += ch; started = true; afterOperator = false;
  }
  if (quote || afterOperator) return null;
  if (started || words.length) stage();
  return stages.length && stages.length <= 64 ? { stages, conditional } : null;
}

const generic = (): CommandDescription => ({ title: t('Выполнение команды'), description: t('Выполнить команду с правами приложения; проверьте полный текст и условия запуска.') });
const result = (title: string, description: string): CommandDescription => ({ title: t(title), description: t(description) });
function operation(words: string[]): CommandDescription | null {
  const [program, ...args] = words;
  const bin = program?.split('/').at(-1), sub = args[0];
  if (bin === 'git') {
    if (['status', 'diff', 'log', 'show'].includes(sub)) return result('Проверка Git', 'Просмотреть состояние или историю репозитория.');
    if (sub === 'commit') return result('Создание коммита', 'Создать Git-коммит с подготовленными изменениями.');
    if (sub === 'add') return result('Подготовка Git-изменений', 'Добавить выбранные изменения в индекс Git.');
    if (sub === 'reset') return { ...result('Сброс Git-изменений', 'Изменить индекс или историю Git; --hard также удаляет незакоммиченные правки.'), destructive: true };
    if (sub === 'push') return { ...result('Отправка Git-изменений', 'Отправить изменения в удалённый репозиторий; принудительная отправка может заменить историю.'), destructive: args.some(a => ['-f', '--force', '--force-with-lease'].some(f => a === f || a.startsWith(f + '='))) };
    if ((sub === 'branch' && args[1] && !args[1].startsWith('-')) || (['switch', 'checkout'].includes(sub) && args.some(a => ['-b', '-B', '-c', '-C'].includes(a)))) return result('Создание ветки', 'Создать или переключить Git-ветку; проверьте команду.');
    return result('Операция Git', 'Выполнить операцию с репозиторием; команда показана ниже.');
  }
  if (['npm', 'pnpm', 'yarn'].includes(bin ?? '')) {
    if (['install', 'ci', 'add'].includes(sub)) return result('Установка зависимостей', 'Установить зависимости проекта. Их скрипты могут исполнять сторонний код.');
    const script = sub === 'run' ? args[1] : sub;
    if (script === 'build') return result('Сборка проекта', 'Запустить скрипт сборки проекта.');
    if (['test', 'lint', 'typecheck', 'check'].includes(script)) return result('Проверка проекта', 'Запустить проверки, определённые в проекте.');
    return null;
  }
  if (['pip', 'pip3'].includes(bin ?? '') && sub === 'install') {
    const at = args.findIndex(a => ['-r', '--requirement'].includes(a));
    const file = at >= 0 ? args[at + 1] : args.find(a => a.startsWith('--requirement='))?.slice(14);
    return { title: t('Установка Python-зависимостей'), description: file ? tr`Установит пакеты из ${file}.` : t('Установит Python-пакеты; установка может исполнять сторонний код.') };
  }
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(bin ?? '')) {
    if (args[0] === '-m' && ['pip', 'pytest'].includes(args[1])) return operation([args[1], ...args.slice(2)]);
    return result('Выполнение Python', 'Выполнить Python-скрипт; его содержание определяет действия.');
  }
  if (bin === 'pytest') return result('Проверка проекта', 'Запустить проверки, определённые в проекте.');
  if (bin === 'rm') {
    const recursive = args.some(a => /^-[^-]*[rR]/.test(a) || a === '--recursive');
    const targets = args.filter(a => !a.startsWith('-')).map(a => a.replace(/^\.\//, '')).join(', ');
    return { title: t(recursive ? 'Удаление каталога' : 'Удаление файлов'), description: targets ? recursive ? tr`Рекурсивно удалит ${targets} и содержимое.` : tr`Удалит ${targets}.` : t('Удалить указанные файлы.'), destructive: true };
  }
  if (bin === 'find' && args.includes('-delete')) return { ...generic(), destructive: true };
  if (bin === 'find' && args.some(a => ['-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf'].includes(a)) || bin === 'rg' && args.some(a => a === '--pre' || a.startsWith('--pre='))) return null;
  if (['ls', 'cat', 'find', 'grep', 'rg', 'head', 'tail', 'wc'].includes(bin ?? '')) return result('Проверка структуры проекта', 'Просмотреть выбранные файлы, каталоги или результаты поиска.');
  if (['df', 'du', 'free', 'ps', 'nvidia-smi'].includes(bin ?? '')) return result('Проверка ресурсов системы', 'Проверить выбранные сведения о дисках, памяти или процессах.');
  if (['curl', 'wget'].includes(bin ?? '')) return result('Сетевой запрос', 'Обратиться к указанному адресу; параметры определяют передачу и сохранение данных.');
  if (bin === 'mkdir') return result('Создание каталога', 'Создать указанные каталоги.');
  if (bin === 'cp') return result('Копирование файлов', 'Скопировать файлы; существующие данные могут быть заменены.');
  if (bin === 'mv') return result('Перемещение файлов', 'Переместить или переименовать файлы; существующие данные могут быть заменены.');
  return null;
}

/** Observed command components, not intent inference, safety or success claims. */
export function commandPresentation(command: string): CommandDescription {
  const list = describeShellWords(command); if (!list) return generic();
  const stages = list.stages.filter(words => words[0] !== 'cd' || words.length !== 2);
  const operations = stages.map(operation);
  const destructive = operations.some(o => o?.destructive);
  if (!stages.length || operations.some(o => !o)) return { ...generic(), ...(destructive ? { destructive: true } : {}) };
  if (operations.length === 1) return operations[0]!;
  const bins = stages.map(w => w[0].split('/').at(-1));
  if (!list.conditional && bins.every(b => ['git', 'df', 'du', 'free', 'ps', 'nvidia-smi'].includes(b!)) && stages.filter(w => w[0] === 'git').every(w => ['status', 'log', 'diff'].includes(w[1])) && bins.includes('git') && bins.includes('df') && bins.includes('nvidia-smi')) return result('Проверка Git и ресурсов системы', 'Проверит состояние репозитория, свободное место и использование видеопамяти.');
  if (!list.conditional && !destructive && bins.every(b => ['ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'find'].includes(b!))) {
    const args = stages.flat();
    if (args.some(a => /(?:localization\/)?dictionaries\/?$/.test(a)) && args.includes('package.json') && args.some(a => /(?:^|\/)python\/?$/.test(a))) return result('Проверка структуры проекта', 'Покажет словари локализации, настройки package.json и каталоги Python-скриптов.');
    return result('Проверка структуры проекта', 'Просмотреть выбранные файлы, каталоги или результаты поиска.');
  }
  const titles = [...new Set(operations.map(o => o!.title))].join('; ');
  return { title: t('Несколько операций'), description: tr`Состав команды: ${titles}. Порядок и условия выполнения указаны в команде.`, ...(destructive ? { destructive: true } : {}) };
}
