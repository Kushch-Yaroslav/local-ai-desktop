import { Folder } from 'lucide-react';
import { projectDirectoryName } from '../../shared/project-references';

/** Same compact folder identity in project selectors and approval requests. */
export function ProjectBadge({ path, label, tabIndex }: { path?: string | null; label?: string; tabIndex?: number }) {
  return <span className={`project-folder-badge ${path ? 'selected' : 'empty'}`} title={path ?? undefined} aria-label={path ?? label} tabIndex={tabIndex}>
    <Folder size={20} aria-hidden="true" /><span>{label ?? (path ? projectDirectoryName(path) : '')}</span>
  </span>;
}
