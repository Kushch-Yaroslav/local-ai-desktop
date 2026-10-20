import { t } from './locale';
import type { ToolActivity, RiskCategory } from './types';

import { commandPresentation } from './command-description';
export { commandPresentation } from './command-description';

export function permissionPresentation(category: RiskCategory, detail = '') {
  if(category==='browser_preview')return {title:t('Браузерная проверка'),description:t('Локальный preview выбранного проекта: только разрешённый origin и GET, без внешней сети.')};
  if (/^(read_file|list_directory):/.test(detail)) return { title: t('Изучение файла'), description: t('Прочитать данные в указанном месте.') };
  if (/^(create_file|write_file|replace_text|apply_patch|project_knowledge_update):/.test(detail)) return { title: t('Изменение проекта'), description: t('Изменить файлы проекта; состав операции приведён в деталях.') };
  if (/^download_file:/.test(detail)) return { title: t('Загрузка файла'), description: t('Скачать ресурс и сохранить его в указанном месте. Загрузка не подтверждает установку.') };
  if (['system_command', 'git_commit', 'git_push', 'destructive_git', 'package_install', 'package_remove', 'shell_chaining', 'shell_redirection'].includes(category)) return commandPresentation(detail);
  if (category === 'file_download') return { title: t('Загрузка файла'), description: t('Скачать ресурс и сохранить его в указанном месте. Загрузка не подтверждает установку.') };
  if (category === 'file_delete') return { title: t('Удаление файлов'), description: t('Удалить выбранные файлы. Состав операции приведён в деталях.'), destructive: true };
  return { title: t('Изменение проекта'), description: t('Выполнить операцию с файлами проекта; проверьте цель и детали.') };
}

export function activityPresentation(activity: ToolActivity): { title: string; context?: string } {
  const tool = activity.toolName ?? activity.detail;
  // Historical cards may lack structured call metadata. Recover only the small
  // path field; never parse/pretty-print an entire collapsed tool result.
  const oldPath = /"path"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(activity.output?.slice(0, 1024) ?? '');
  let historicalPath: string | undefined;
  if (oldPath) { try { historicalPath = JSON.parse(oldPath[1]) as string; } catch { /* damaged old result */ } }
  const path = typeof activity.arguments?.path === 'string' ? activity.arguments.path : historicalPath;
  if (activity.kind === 'terminal') return { title: commandPresentation(activity.terminal?.command ?? (typeof activity.arguments?.command === 'string' ? activity.arguments.command : activity.detail ?? '')).title, context: activity.terminal?.cwd };
  if (tool === 'observation_read' || tool === 'observation_index') return { title: t('Анализ предыдущих результатов') };
  if (tool === 'download_file') return { title: /\.(safetensors|gguf|pth|ckpt)$/i.test(path ?? activity.detail ?? '') ? t('Загрузка весов модели') : t('Загрузка файла'), context: path ?? activity.detail };
  const titles: Record<string, string> = { file_read: 'Изучение файла', mutation: 'Изменение файла', directory: 'Просмотр структуры проекта', context: 'Контекст сжат', git: 'Проверка Git', notes: 'Заметки задачи', planning: 'Планирование', web: 'Поиск информации', progress: 'Ход работы', search: 'Поиск в проекте' };
  const name = titles[activity.kind ?? ''];
  return { title: name ? t(name) : t('Действие агента'), context: path ?? (tool && !/^[a-z]+(?:_[a-z]+)+$/.test(tool) ? tool : undefined) };
}
