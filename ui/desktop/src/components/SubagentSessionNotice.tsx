// Modified for Local AI Desktop: refresh saved child progress from execution events.
import { useEffect, useRef } from 'react';
import { SUBAGENT_UPDATED, type SubagentSession } from '../acp/subagentSessions';
import { Info, RefreshCw } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { Button } from './ui/button';
import { cn } from '../utils';

const i18n = defineMessages({
  notice: {
    id: 'subagentSessionNotice.notice',
    defaultMessage: 'Saved subagent progress refreshes as execution events arrive.',
  },
  loadLatestProgress: {
    id: 'subagentSessionNotice.loadLatestProgress',
    defaultMessage: 'Load latest progress',
  },
});

interface SubagentSessionNoticeProps {
  refreshing: boolean;
  sessionId?: string;
  onRefresh: () => void;
}

export function SubagentSessionNotice({
  refreshing,
  onRefresh,
  sessionId,
}: SubagentSessionNoticeProps) {
  const intl = useIntl();
  const pending = useRef(false);
  useEffect(() => {
    pending.current = false;
  }, [sessionId]);
  useEffect(() => {
    if (!refreshing && pending.current) {
      pending.current = false;
      onRefresh();
    }
  }, [refreshing, onRefresh]);
  useEffect(() => {
    const update = (event: Event) => {
      if ((event as CustomEvent<SubagentSession>).detail.id === sessionId) {
        if (refreshing) pending.current = true;
        else onRefresh();
      }
    };
    window.addEventListener(SUBAGENT_UPDATED, update);
    return () => window.removeEventListener(SUBAGENT_UPDATED, update);
  }, [sessionId, refreshing, onRefresh]);

  return (
    <div
      role="status"
      className="relative z-30 mx-4 mb-4 flex items-center justify-between gap-4 rounded-2xl border border-border-primary bg-background-secondary px-4 py-3"
    >
      <span className="flex items-center gap-2 text-sm text-text-primary">
        <Info className="size-4 shrink-0 text-text-secondary" />
        {intl.formatMessage(i18n.notice)}
      </span>
      <Button variant="default" size="sm" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw className={cn(refreshing && 'animate-spin')} />
        {intl.formatMessage(i18n.loadLatestProgress)}
      </Button>
    </div>
  );
}
