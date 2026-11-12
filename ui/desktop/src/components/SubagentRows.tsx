// Modified for Local AI Desktop: compact context summary for delegated sessions.
import { useNavigate } from 'react-router';
import { useSubagentFamily, type SubagentStatus } from '../acp/subagentSessions';
import { defineMessages, useIntl } from '../i18n';
import { SessionIndicators } from './SessionIndicators';
import { formatTokenCount } from '../utils/usageFormatting';

export const subagentMessages = defineMessages({
  main: { id: 'subagentMonitor.main', defaultMessage: 'Main agent' },
  session: { id: 'subagentMonitor.session', defaultMessage: 'Agent session' },
  waiting: { id: 'subagentMonitor.waiting', defaultMessage: 'Waiting' },
  running: { id: 'subagentMonitor.running', defaultMessage: 'Running' },
  compacting: { id: 'subagentMonitor.compacting', defaultMessage: 'Compacting' },
  completed: { id: 'subagentMonitor.completed', defaultMessage: 'Completed' },
  failed: { id: 'subagentMonitor.failed', defaultMessage: 'Failed' },
  cancelled: { id: 'subagentMonitor.cancelled', defaultMessage: 'Cancelled' },
  unknown: { id: 'subagentMonitor.unknown', defaultMessage: 'Saved history' },
  logical: {
    id: 'subagentMonitor.logical',
    defaultMessage: 'Last reported session tokens; these are not physical KV or VRAM usage.',
  },
  compacted: { id: 'subagentMonitor.compacted', defaultMessage: 'Last compaction: {time}' },
  numbered: { id: 'subagentMonitor.numbered', defaultMessage: 'Subagent {number}' },
  summary: {
    id: 'subagentMonitor.summary',
    defaultMessage: 'Subagents · {active} active',
  },
  free: { id: 'subagentMonitor.free', defaultMessage: '{tokens} free' },
});
export function isSubagentActive(status: SubagentStatus) {
  return ['waiting', 'running', 'compacting'].includes(status);
}
export function SubagentRows({ parentId }: { parentId: string }) {
  const { children } = useSubagentFamily(parentId);
  const intl = useIntl();
  const navigate = useNavigate();
  return (
    <div className="ml-5 border-l border-border-primary pl-2">
      {children.map((child) => (
        <button
          key={child.id}
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-background-tertiary text-text-secondary"
          onClick={() => navigate(`/pair?${new URLSearchParams({ resumeSessionId: child.id })}`)}
          title={`${child.id} · ${intl.formatMessage(subagentMessages[child.status])}`}
        >
          <span className="min-w-0 flex-1 truncate text-left">{child.title || child.id}</span>
          <span>{intl.formatMessage(subagentMessages[child.status])}</span>
          <SessionIndicators
            isStreaming={isSubagentActive(child.status)}
            hasUnread={false}
            hasError={child.status === 'failed'}
          />
        </button>
      ))}
    </div>
  );
}

/** Session token estimates are logical context usage, never physical KV/VRAM measurements. */
export function SubagentSummary({ parentId }: { parentId: string }) {
  const { children } = useSubagentFamily(parentId);
  const intl = useIntl();
  if (children.length === 0) return null;

  const active = children.filter((child) => isSubagentActive(child.status)).length;
  return (
    <section
      aria-label={intl.formatMessage(subagentMessages.summary, { active })}
      className="w-full min-w-0 space-y-2 overflow-hidden border-t border-border-primary pt-3"
    >
      <h3 className="text-sm font-medium text-text-primary">
        {intl.formatMessage(subagentMessages.summary, { active })}
      </h3>
      <div className="max-h-36 space-y-2 overflow-y-auto overflow-x-hidden">
        {children.map((child, index) => {
          const usageKnown = child.totalTokens != null && child.contextLimit != null;
          const used = usageKnown ? Math.max(0, child.totalTokens!) : undefined;
          const limit = child.contextLimit;
          const free = usageKnown ? Math.max(0, limit! - used!) : undefined;
          const percent = usageKnown && limit! > 0 ? Math.min(100, (100 * used!) / limit!) : 0;
          const statusLabel = intl.formatMessage(subagentMessages[child.status]);

          return (
            <div key={child.id} className="w-full min-w-0 space-y-1">
              <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-text-primary">
                  {intl.formatMessage(subagentMessages.numbered, { number: index + 1 })} ·{' '}
                  {statusLabel}
                </span>
                <span className="shrink-0 whitespace-nowrap font-mono text-text-secondary">
                  {usageKnown ? `${formatTokenCount(used!)} / ${formatTokenCount(limit!)}` : '—'}
                  {free != null &&
                    ` · ${intl.formatMessage(subagentMessages.free, { tokens: formatTokenCount(free) })}`}
                </span>
              </div>
              <div
                className="h-1.5 w-full min-w-0 overflow-hidden rounded-full bg-background-tertiary"
                role={usageKnown ? 'progressbar' : undefined}
                aria-label={
                  usageKnown
                    ? `${formatTokenCount(used!)} / ${formatTokenCount(limit!)}`
                    : undefined
                }
                aria-valuemin={usageKnown ? 0 : undefined}
                aria-valuemax={usageKnown ? 100 : undefined}
                aria-valuenow={usageKnown ? Math.round(percent) : undefined}
              >
                {usageKnown && (
                  <div
                    className={
                      child.status === 'failed'
                        ? 'h-full rounded-full bg-red-500'
                        : percent >= 80
                          ? 'h-full rounded-full bg-amber-500'
                          : 'h-full rounded-full bg-blue-500'
                    }
                    style={{ width: `${percent}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="break-words text-xs text-text-tertiary">
        {intl.formatMessage(subagentMessages.logical)}
      </p>
    </section>
  );
}
