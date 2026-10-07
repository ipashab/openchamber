import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { fetchTeamActivity, type TeamActivityEvent, type TeamBoard } from '@/lib/team/team-board-api';
import { useUIStore } from '@/stores/useUIStore';

type TaskVisual = { icon: IconName; color?: string };

type TaskVisuals = { [status in 'pending' | 'in_progress' | 'completed']: TaskVisual };

// Доска и фид показывают статусы одними значками — два лица одной команды,
// а не два словаря.
const TASK_VISUALS: TaskVisuals = {
  in_progress: { icon: 'record-circle', color: 'var(--status-info)' },
  pending: { icon: 'time' },
  completed: { icon: 'checkbox-circle', color: 'var(--status-success)' },
};

const REFETCH_DEBOUNCE_MS = 250;

type Props = {
  board: TeamBoard;
  colorOf: (slotId: string) => string | undefined;
  nameOf: (slotId: string) => string;
  /** Test seam: the real view passes nothing and the route's fetch is used. */
  fetchActivity?: typeof fetchTeamActivity;
};

const sortEventsDesc = (events: readonly TeamActivityEvent[]): TeamActivityEvent[] =>
  [...events].sort((left, right) => (right.at - left.at) || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));

/**
 * The team's activity feed: the mailbox and the task board as one
 * newest-first stream, paged from the server. The first page follows the same
 * `team-changed` events the board does — a new event is a new top row — and
 * older retained history arrives only on request, so a long-running team is
 * observed, not replayed by default. Pages already loaded are kept: the
 * refresh merges by event id instead of dropping the history the reader
 * pulled up.
 */
export const TeamActivityView: React.FC<Props> = ({ board, colorOf, nameOf, fetchActivity: fetcher }) => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const fetcherRef = React.useRef<typeof fetchTeamActivity>(fetcher ?? fetchTeamActivity);
  fetcherRef.current = fetcher ?? fetchTeamActivity;

  const [loaded, setLoaded] = React.useState<{
    events: Map<string, TeamActivityEvent>;
    nextCursor: string | null;
  }>({ events: new Map(), nextCursor: null });
  const [loading, setLoading] = React.useState(true);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Одна команда — один стор фида; поздний ответ чужой команды не должен
  // попасть в чужой список.
  const teamIdRef = React.useRef(board.id);
  if (teamIdRef.current !== board.id) teamIdRef.current = board.id;

  const mergePage = (page: { events: TeamActivityEvent[]; nextCursor: string | null }, keepCursor: boolean) => {
    setLoaded((current) => {
      const events = new Map(current.events);
      for (const event of page.events) events.set(event.id, event);
      return {
        events,
        // The older-history cursor belongs to the walk that loaded it; a
        // refreshed first page never silently resets the reader's position.
        nextCursor: keepCursor ? current.nextCursor : page.nextCursor,
      };
    });
  };

  const loadFirstPage = React.useCallback(async () => {
    const teamId = teamIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetcherRef.current(teamId);
      if (teamIdRef.current !== teamId) return;
      setLoaded({ events: new Map(page.events.map((event) => [event.id, event])), nextCursor: page.nextCursor });
    } catch (cause) {
      if (teamIdRef.current !== teamId) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (teamIdRef.current === teamId) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadFirstPage();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void loadFirstPage();
      }, REFETCH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'team-changed') schedule();
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [loadFirstPage]);

  const loadOlder = async () => {
    if (loadingOlder || loaded.nextCursor === null) return;
    const teamId = teamIdRef.current;
    const cursor = loaded.nextCursor;
    setLoadingOlder(true);
    setError(null);
    try {
      const page = await fetcherRef.current(teamId, { before: cursor });
      if (teamIdRef.current !== teamId) return;
      mergePage(page, true);
    } catch (cause) {
      if (teamIdRef.current !== teamId) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (teamIdRef.current === teamId) setLoadingOlder(false);
    }
  };

  const formatStamp = (timestamp: number): string =>
    formatDateTimeForPreference(timestamp, timeFormatPreference, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  const events = sortEventsDesc([...loaded.events.values()]);
  const memberName = (slotId: string): React.ReactNode => {
    const color = colorOf(slotId);
    return color ? <span style={{ color }}>{nameOf(slotId)}</span> : nameOf(slotId);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="min-h-40 flex-1 space-y-2 overflow-y-auto">
        {events.length === 0 && !loading ? (
          <div className="flex h-full min-h-40 items-center justify-center text-[13px] text-muted-foreground">
            {t('chat.workStatus.teamBoard.activity.empty')}
          </div>
        ) : null}
        {events.map((event) => event.kind === 'message' ? (
          <div
            key={`message:${event.id}`}
            className="rounded-lg border border-border bg-[var(--surface-muted)]/40 px-2.5 py-1.5"
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium leading-4">
              <Icon name="chat-history" className="size-3.5 shrink-0" />
              <span className="truncate">{memberName(event.from)}</span>
              <span className="shrink-0 text-muted-foreground">→</span>
              <span className="truncate">{memberName(event.to)}</span>
              <span className="ml-auto shrink-0 pl-2 text-muted-foreground">{formatStamp(event.at)}</span>
            </div>
            <div
              className="mt-1 line-clamp-3 text-[13px] text-foreground"
              title={event.content}
            >
              {event.content}
            </div>
          </div>
        ) : (
          <div
            key={`task:${event.id}`}
            className="flex items-start gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[13px]"
            aria-label={t('chat.workStatus.teamBoard.activity.taskRow', { subject: event.subject, status: t(`chat.workStatus.teamBoard.status.${event.status}`) })}
          >
            <span className="mt-px flex size-4 shrink-0 items-center justify-center">
              <Icon
                name={TASK_VISUALS[event.status].icon}
                className="size-3.5"
                style={TASK_VISUALS[event.status].color ? { color: TASK_VISUALS[event.status].color } : undefined}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-foreground">{event.subject}</span>
              {event.owner ? (
                <span className="mt-0.5 block truncate text-[11px] font-medium">{memberName(event.owner)}</span>
              ) : null}
            </span>
            <span className="mt-px shrink-0 pl-2 text-[11px] text-muted-foreground">{formatStamp(event.at)}</span>
          </div>
        ))}
        {loading ? (
          <div className="flex h-20 items-center justify-center" aria-live="polite">
            <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {error ? (
          <div className="rounded-md border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 px-2.5 py-1.5 text-xs text-foreground">
            {error}
          </div>
        ) : null}
        {loaded.nextCursor !== null ? (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {t('chat.workStatus.teamBoard.activity.loadOlder')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
