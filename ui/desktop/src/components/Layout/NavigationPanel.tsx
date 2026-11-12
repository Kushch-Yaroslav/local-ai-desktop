// Modified for Local AI Desktop: show delegated sessions below their parent chat.
import { SubagentRows } from '../SubagentRows';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AudioLines, ChevronDown, ChevronRight, MoreHorizontal, Trash2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useNavigationContext } from './NavigationContext';
import { useConfig } from '../ConfigContext';
import { useNavigationSessions } from '../../hooks/useNavigationSessions';
import {
  NAV_ITEMS,
  SETTINGS_NAV_ITEM,
  getNavItemLabel,
  type NavItem,
} from '../../hooks/useNavigationItems';
import { AppEvents } from '../../constants/events';
import { InlineEditText } from '../common/InlineEditText';
import { SessionIndicators } from '../SessionIndicators';
import {
  acpDeleteSession,
  acpGetSessionDeletionPlan,
  acpListAllSessions,
  acpRenameSession,
  ActiveSessionDeletionError,
  type SessionListItem,
} from '../../acp/sessions';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/Tooltip';
import { ConfirmationModal } from '../ui/ConfirmationModal';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { formatMessageTimestamp } from '../../utils/timeUtils';
import { cn } from '../../utils';
import { sessionsInProject, type ProjectGroup } from '../../utils/projectSessions';
import { defineMessages, useIntl } from '../../i18n';
import { toast } from 'react-toastify';
import { errorMessage } from '../../utils/conversionUtils';
import { acpChatSessionActions } from '../../acp/chatSessionStore';
import { forgetSessionConfiguration } from '../../acp/sessionConfiguration';
import { forgetSubagentSessions } from '../../acp/subagentSessions';

type StreamState = 'idle' | 'loading' | 'streaming' | 'error';

interface SessionStatus {
  streamState: StreamState;
  hasUnreadActivity: boolean;
}

const i18n = defineMessages({
  chats: {
    id: 'navigationPanel.chats',
    defaultMessage: 'Chats',
  },
  noChats: {
    id: 'navigationPanel.noChats',
    defaultMessage: 'No recent chats',
  },
  loadingChats: {
    id: 'navigationPanel.loadingChats',
    defaultMessage: 'Loading chats…',
  },
  untitledSession: {
    id: 'navigationPanel.untitledSession',
    defaultMessage: 'Untitled session',
  },
  metaModel: {
    id: 'navigationPanel.metaModel',
    defaultMessage: 'Model',
  },
  metaDirectory: {
    id: 'navigationPanel.metaDirectory',
    defaultMessage: 'Directory',
  },
  metaStatus: {
    id: 'navigationPanel.metaStatus',
    defaultMessage: 'Status',
  },
  metaCreated: {
    id: 'navigationPanel.metaCreated',
    defaultMessage: 'Created',
  },
  metaUpdated: {
    id: 'navigationPanel.metaUpdated',
    defaultMessage: 'Updated',
  },
  statusStreaming: {
    id: 'navigationPanel.statusStreaming',
    defaultMessage: 'Streaming',
  },
  statusError: {
    id: 'navigationPanel.statusError',
    defaultMessage: 'Error',
  },
  statusUnread: {
    id: 'navigationPanel.statusUnread',
    defaultMessage: 'Unread activity',
  },
  statusIdle: {
    id: 'navigationPanel.statusIdle',
    defaultMessage: 'Idle',
  },
  returnToActiveLiveVoice: {
    id: 'liveVoice.returnToActive',
    defaultMessage: 'Return to active Live voice',
  },
  moreChatActions: { id: 'navigationPanel.moreChatActions', defaultMessage: 'More chat actions' },
  moreProjectActions: {
    id: 'navigationPanel.moreProjectActions',
    defaultMessage: 'More catalog actions',
  },
  deleteChatAction: { id: 'navigationPanel.deleteChatAction', defaultMessage: 'Delete chat' },
  deleteProjectAction: {
    id: 'navigationPanel.deleteProjectAction',
    defaultMessage: 'Delete catalog and chats',
  },
  deleteConfirm: { id: 'navigationPanel.deleteConfirm', defaultMessage: 'Delete' },
  cancel: { id: 'navigationPanel.cancel', defaultMessage: 'Cancel' },
  unknownProject: { id: 'navigationPanel.unknownProject', defaultMessage: 'Unknown directory' },
  deleteChatTitle: { id: 'navigationPanel.deleteChatTitle', defaultMessage: 'Delete chat?' },
  deleteChatMessage: {
    id: 'navigationPanel.deleteChatMessage',
    defaultMessage:
      'Delete the saved chat “{name}” and its subagent histories? This action cannot be undone.',
  },
  deleteProjectTitle: {
    id: 'navigationPanel.deleteProjectTitle',
    defaultMessage: 'Delete catalog and chats?',
  },
  deleteProjectMessage: {
    id: 'navigationPanel.deleteProjectMessage',
    defaultMessage:
      'Delete {count} saved {count, plural, one {chat} other {chats}} from “{name}”, including their subagent histories? Project files will remain untouched.',
  },
  deleteBusy: {
    id: 'navigationPanel.deleteBusy',
    defaultMessage: 'A chat or subagent is still running. Stop generation before deleting it.',
  },
  deleteStale: {
    id: 'navigationPanel.deleteStale',
    defaultMessage: 'The chat list changed. Review the updated count and confirm again.',
  },
  deleteChatSuccess: {
    id: 'navigationPanel.deleteChatSuccess',
    defaultMessage: 'Chat and subagent histories deleted.',
  },
  deleteProjectSuccess: {
    id: 'navigationPanel.deleteProjectSuccess',
    defaultMessage: 'Deleted {count} chats and their subagent histories.',
  },
  deletePartialFailure: {
    id: 'navigationPanel.deletePartialFailure',
    defaultMessage: 'Deleted {deleted} of {total} chats. Remaining chats were kept: {error}',
  },
  deleteFailure: {
    id: 'navigationPanel.deleteFailure',
    defaultMessage: 'Could not delete chat: {error}',
  },
});

type DeleteTarget =
  | { kind: 'chat'; session: SessionListItem }
  | { kind: 'project'; path: string; label: string; sessions: SessionListItem[] };

function sameSessionIds(left: SessionListItem[], right: SessionListItem[]): boolean {
  if (left.length !== right.length) return false;
  const ids = new Set(left.map((session) => session.id));
  return right.every((session) => ids.has(session.id));
}

const navItemClass = (active: boolean) =>
  cn(
    'flex flex-row items-center gap-3 outline-none no-drag w-full',
    'rounded-full px-3 py-2 text-sm font-medium transition-colors',
    active
      ? 'bg-background-tertiary text-text-primary'
      : 'text-text-primary hover:bg-background-tertiary/60'
  );

interface NavRowProps {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}

const NavRow: React.FC<NavRowProps> = ({ item, active, onClick }) => {
  const intl = useIntl();
  const Icon = item.icon;
  return (
    <button onClick={onClick} className={navItemClass(active)}>
      <Icon className="w-5 h-5 flex-shrink-0 text-text-secondary" />
      <span className="text-left flex-1 truncate">{getNavItemLabel(item, intl)}</span>
    </button>
  );
};

interface SessionRowProps {
  session: SessionListItem;
  active: boolean;
  isLiveVoiceActive: boolean;
  status: SessionStatus | undefined;
  onClick: () => void;
  onRenamed: () => void;
  onDelete: () => void;
}

const formatTimestamp = (value?: string): string | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return formatMessageTimestamp(parsed / 1000);
};

const MetaRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-2">
    <span className="text-text-inverse/60 flex-shrink-0">{label}</span>
    <span className="text-right ml-auto break-all">{value}</span>
  </div>
);

interface SessionTooltipContentProps {
  session: SessionListItem;
  statusLabel: string;
}

const SessionTooltipContent: React.FC<SessionTooltipContentProps> = ({ session, statusLabel }) => {
  const intl = useIntl();
  const model = session.modelId
    ? session.providerId
      ? `${session.modelId} (${session.providerId})`
      : session.modelId
    : session.providerId;
  const created = formatTimestamp(session.createdAt);
  const updated = formatTimestamp(session.lastMessageAt ?? session.updatedAt);

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="font-medium break-words">
        {session.name || intl.formatMessage(i18n.untitledSession)}
      </div>
      <div className="flex flex-col gap-0.5">
        {model && <MetaRow label={intl.formatMessage(i18n.metaModel)} value={model} />}
        {session.workingDir && (
          <MetaRow label={intl.formatMessage(i18n.metaDirectory)} value={session.workingDir} />
        )}
        <MetaRow label={intl.formatMessage(i18n.metaStatus)} value={statusLabel} />
        {created && <MetaRow label={intl.formatMessage(i18n.metaCreated)} value={created} />}
        {updated && <MetaRow label={intl.formatMessage(i18n.metaUpdated)} value={updated} />}
      </div>
    </div>
  );
};

const SessionRow: React.FC<SessionRowProps> = ({
  session,
  active,
  isLiveVoiceActive,
  status,
  onClick,
  onRenamed,
  onDelete,
}) => {
  const intl = useIntl();
  const [isEditing, setIsEditing] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isStreaming = status?.streamState === 'streaming';
  const hasError = status?.streamState === 'error';
  const hasUnread = status?.hasUnreadActivity ?? false;

  const statusLabel = isStreaming
    ? intl.formatMessage(i18n.statusStreaming)
    : hasError
      ? intl.formatMessage(i18n.statusError)
      : hasUnread
        ? intl.formatMessage(i18n.statusUnread)
        : intl.formatMessage(i18n.statusIdle);

  return (
    <Tooltip open={tooltipOpen && !isEditing} onOpenChange={setTooltipOpen} delayDuration={400}>
      <TooltipTrigger asChild>
        <div
          onClick={() => !isEditing && onClick()}
          className={cn(
            'group flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer text-sm',
            'hover:bg-background-tertiary/60 transition-colors',
            active && 'bg-background-tertiary'
          )}
        >
          <InlineEditText
            value={session.name}
            onSave={async (newName) => {
              await acpRenameSession(session.id, newName);
              window.dispatchEvent(
                new CustomEvent(AppEvents.SESSION_RENAMED, {
                  detail: { sessionId: session.id, newName, userInitiated: true },
                })
              );
              onRenamed();
            }}
            placeholder={intl.formatMessage(i18n.untitledSession)}
            disabled={isStreaming}
            singleClickEdit={false}
            className="truncate text-text-primary flex-1 !px-0 !py-0 hover:bg-transparent"
            editClassName="!text-sm"
            onEditStart={() => setIsEditing(true)}
            onEditEnd={() => setIsEditing(false)}
          />
          {isLiveVoiceActive && (
            <AudioLines
              className="w-3.5 h-3.5 flex-shrink-0 text-blue-500"
              aria-label={intl.formatMessage(i18n.returnToActiveLiveVoice)}
            />
          )}
          <SessionIndicators isStreaming={isStreaming} hasUnread={hasUnread} hasError={hasError} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={intl.formatMessage(i18n.moreChatActions)}
                title={intl.formatMessage(i18n.moreChatActions)}
                onClick={(event) => event.stopPropagation()}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-text-tertiary opacity-0 transition-opacity hover:bg-background-secondary hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 />
                {intl.formatMessage(i18n.deleteChatAction)}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-xs text-left">
        <SessionTooltipContent session={session} statusLabel={statusLabel} />
      </TooltipContent>
    </Tooltip>
  );
};

export const Navigation: React.FC<{
  activeLiveVoiceSessionId: string | null;
}> = ({ activeLiveVoiceSessionId }) => {
  const intl = useIntl();
  const { isNavExpanded } = useNavigationContext();
  const location = useLocation();
  const navigate = useNavigate();
  const { extensionsList } = useConfig();

  const appsExtensionEnabled = !!extensionsList.find((ext) => ext.name === 'apps')?.enabled;

  const visibleItems = useMemo<NavItem[]>(() => {
    return NAV_ITEMS.filter((item) => {
      if (item.path === '/apps') return appsExtensionEnabled;
      return true;
    });
  }, [appsExtensionEnabled]);

  const isActive = useCallback((path: string) => location.pathname === path, [location.pathname]);

  const {
    recentSessions,
    recentSessionsByProject,
    isLoadingSessions,
    activeSessionId,
    fetchSessions,
    handleNavClick,
    handleSessionClick,
  } = useNavigationSessions();

  const [sessionStatuses, setSessionStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const handleStatusUpdate = (event: Event) => {
      const { sessionId, streamState } = (event as CustomEvent).detail;
      setSessionStatuses((prev) => {
        const existing = prev.get(sessionId);
        const shouldMarkUnread = existing?.streamState === 'streaming' && streamState === 'idle';
        const next = new Map(prev);
        next.set(sessionId, {
          streamState,
          hasUnreadActivity: existing?.hasUnreadActivity || shouldMarkUnread,
        });
        return next;
      });
    };

    window.addEventListener(AppEvents.SESSION_STATUS_UPDATE, handleStatusUpdate);
    return () => window.removeEventListener(AppEvents.SESSION_STATUS_UPDATE, handleStatusUpdate);
  }, []);

  const clearUnread = useCallback((sessionId: string) => {
    setSessionStatuses((prev) => {
      const status = prev.get(sessionId);
      if (status?.hasUnreadActivity) {
        const next = new Map(prev);
        next.set(sessionId, { ...status, hasUnreadActivity: false });
        return next;
      }
      return prev;
    });
  }, []);

  const navFocusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isNavExpanded) {
      fetchSessions();
      requestAnimationFrame(() => navFocusRef.current?.focus());
    }
  }, [isNavExpanded, fetchSessions]);

  const [isChatsExpanded, setIsChatsExpanded] = useState(true);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  const toggleProjectCollapsed = useCallback((path: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const requestDeleteProject = useCallback(
    async (group: ProjectGroup) => {
      try {
        const allSessions = await acpListAllSessions({ includeAcp: true });
        setDeleteTarget({
          kind: 'project',
          path: group.path,
          label: group.label,
          sessions: sessionsInProject(allSessions, group.path),
        });
      } catch (error) {
        toast.error(
          intl.formatMessage(i18n.deleteFailure, {
            error: errorMessage(error, 'Unknown error'),
          })
        );
      }
    },
    [intl]
  );

  const publishDeletedSessions = useCallback((sessionIds: string[]) => {
    const uniqueIds = [...new Set(sessionIds)];
    if (uniqueIds.length === 0) return uniqueIds;
    uniqueIds.forEach((id) => {
      acpChatSessionActions.deleteSnapshot(id);
      forgetSessionConfiguration(id);
    });
    forgetSubagentSessions(uniqueIds);
    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_DELETED, { detail: { sessionIds: uniqueIds } })
    );
    return uniqueIds;
  }, []);

  const leaveDeletedActiveChat = useCallback(
    (deletedIds: string[]) => {
      if (
        location.pathname !== '/pair' ||
        !activeSessionId ||
        !deletedIds.includes(activeSessionId)
      ) {
        return;
      }
      const deleted = new Set(deletedIds);
      const fallback = recentSessions.find((session) => !deleted.has(session.id));
      if (fallback) handleSessionClick(fallback.id);
      else navigate('/');
    },
    [activeSessionId, handleSessionClick, location.pathname, navigate, recentSessions]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || isDeleting) return;

    setIsDeleting(true);
    let roots: SessionListItem[] = [];
    let plans: Awaited<ReturnType<typeof acpGetSessionDeletionPlan>>[] = [];
    const deletedIds: string[] = [];

    try {
      if (deleteTarget.kind === 'chat') {
        roots = [deleteTarget.session];
      } else {
        const latest = sessionsInProject(
          await acpListAllSessions({ includeAcp: true }),
          deleteTarget.path
        );
        if (!sameSessionIds(deleteTarget.sessions, latest)) {
          setDeleteTarget({ ...deleteTarget, sessions: latest });
          toast.info(intl.formatMessage(i18n.deleteStale));
          return;
        }
        roots = latest;
      }

      for (const root of roots) {
        plans.push(await acpGetSessionDeletionPlan(root.id));
      }
      if (plans.some((plan) => plan.activeSessionIds.length > 0)) {
        throw new ActiveSessionDeletionError();
      }

      for (let index = 0; index < roots.length; index++) {
        await acpDeleteSession(roots[index].id);
        deletedIds.push(...plans[index].sessionIds);
      }

      const removed = publishDeletedSessions(deletedIds);
      setDeleteTarget(null);
      if (deleteTarget.kind === 'chat') {
        toast.success(intl.formatMessage(i18n.deleteChatSuccess));
      } else {
        toast.success(intl.formatMessage(i18n.deleteProjectSuccess, { count: roots.length }));
      }
      leaveDeletedActiveChat(removed);
    } catch (error) {
      const removed = publishDeletedSessions(deletedIds);
      if (deletedIds.length > 0) {
        setDeleteTarget(null);
        toast.error(
          intl.formatMessage(i18n.deletePartialFailure, {
            deleted: roots.filter((root) => deletedIds.includes(root.id)).length,
            total: roots.length,
            error: errorMessage(error, 'Unknown error'),
          })
        );
        leaveDeletedActiveChat(removed);
      } else if (error instanceof ActiveSessionDeletionError) {
        toast.error(intl.formatMessage(i18n.deleteBusy));
      } else {
        toast.error(
          intl.formatMessage(i18n.deleteFailure, {
            error: errorMessage(error, 'Unknown error'),
          })
        );
      }
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, isDeleting, intl, leaveDeletedActiveChat, publishDeletedSessions]);

  const deleteTitle =
    deleteTarget?.kind === 'project'
      ? intl.formatMessage(i18n.deleteProjectTitle)
      : intl.formatMessage(i18n.deleteChatTitle);
  const deleteMessage =
    deleteTarget?.kind === 'project'
      ? intl.formatMessage(i18n.deleteProjectMessage, {
          count: deleteTarget.sessions.length,
          name: deleteTarget.label,
        })
      : intl.formatMessage(i18n.deleteChatMessage, {
          name:
            deleteTarget?.kind === 'chat'
              ? deleteTarget.session.name || intl.formatMessage(i18n.untitledSession)
              : '',
        });

  if (!isNavExpanded) return null;

  return (
    <motion.div
      ref={navFocusRef}
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="bg-background-primary outline-none flex flex-col h-full"
    >
      <div className="h-[48px] no-drag" />

      <div className="px-2 flex flex-col gap-0.5">
        {visibleItems.map((item) => (
          <NavRow
            key={item.id}
            item={item}
            active={isActive(item.path)}
            onClick={() => handleNavClick(item.path)}
          />
        ))}
      </div>

      <div className="flex-1 min-h-0 flex flex-col mt-3">
        <button
          onClick={() => setIsChatsExpanded((v) => !v)}
          className="flex items-center gap-1 px-4 py-1 text-xs font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors self-start"
        >
          {isChatsExpanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          <span>{intl.formatMessage(i18n.chats)}</span>
        </button>
        {isChatsExpanded && (
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 mt-1">
            {recentSessions.length === 0 ? (
              <div className="px-3 py-2 text-xs text-text-secondary">
                {intl.formatMessage(isLoadingSessions ? i18n.loadingChats : i18n.noChats)}
              </div>
            ) : recentSessionsByProject.length > 0 ? (
              recentSessionsByProject.map((group: ProjectGroup) => {
                const isCollapsed = collapsedProjects.has(group.path);
                return (
                  <React.Fragment key={group.path}>
                    <div className="group flex w-full items-center gap-1 px-3 pt-2 pb-0.5">
                      <button
                        onClick={() => toggleProjectCollapsed(group.path)}
                        aria-expanded={!isCollapsed}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] uppercase tracking-wider text-text-tertiary transition-colors hover:text-text-secondary"
                        title={group.path}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="w-3 h-3 flex-shrink-0" />
                        ) : (
                          <ChevronDown className="w-3 h-3 flex-shrink-0" />
                        )}
                        <span className="truncate">{group.label}</span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={intl.formatMessage(i18n.moreProjectActions)}
                            title={intl.formatMessage(i18n.moreProjectActions)}
                            className="flex size-6 shrink-0 items-center justify-center rounded-full text-text-tertiary opacity-0 transition-opacity hover:bg-background-secondary hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => void requestDeleteProject(group)}
                          >
                            <Trash2 />
                            {intl.formatMessage(i18n.deleteProjectAction)}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {!isCollapsed &&
                      group.sessions.map((session) => (
                        <React.Fragment key={session.id}>
                          <SessionRow
                            session={session}
                            active={session.id === activeSessionId}
                            isLiveVoiceActive={session.id === activeLiveVoiceSessionId}
                            status={sessionStatuses.get(session.id)}
                            onClick={() => {
                              clearUnread(session.id);
                              handleSessionClick(session.id);
                            }}
                            onRenamed={fetchSessions}
                            onDelete={() => setDeleteTarget({ kind: 'chat', session })}
                          />
                          <SubagentRows parentId={session.id} />
                        </React.Fragment>
                      ))}
                  </React.Fragment>
                );
              })
            ) : (
              recentSessions.map((session) => (
                <React.Fragment key={session.id}>
                  <SessionRow
                    session={session}
                    active={session.id === activeSessionId}
                    isLiveVoiceActive={session.id === activeLiveVoiceSessionId}
                    status={sessionStatuses.get(session.id)}
                    onClick={() => {
                      clearUnread(session.id);
                      handleSessionClick(session.id);
                    }}
                    onRenamed={fetchSessions}
                    onDelete={() => setDeleteTarget({ kind: 'chat', session })}
                  />
                  <SubagentRows parentId={session.id} />
                </React.Fragment>
              ))
            )}
          </div>
        )}
      </div>

      <div className="px-2 pt-2 pb-2 border-t border-border-secondary">
        <NavRow
          item={SETTINGS_NAV_ITEM}
          active={isActive(SETTINGS_NAV_ITEM.path)}
          onClick={() => handleNavClick(SETTINGS_NAV_ITEM.path)}
        />
      </div>
      <ConfirmationModal
        isOpen={deleteTarget !== null}
        title={deleteTitle}
        message={deleteMessage}
        detail={
          deleteTarget?.kind === 'project' ? (
            <code>{deleteTarget.path || intl.formatMessage(i18n.unknownProject)}</code>
          ) : undefined
        }
        confirmLabel={intl.formatMessage(i18n.deleteConfirm)}
        cancelLabel={intl.formatMessage(i18n.cancel)}
        confirmVariant="destructive"
        isSubmitting={isDeleting}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => {
          if (!isDeleting) setDeleteTarget(null);
        }}
      />
    </motion.div>
  );
};
