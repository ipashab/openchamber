import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useTeamBoard } from '@/hooks/useTeamBoard';
import type { TeamMember, TeamTask, TeamTaskStatus } from '@/lib/team/team-board-api';

const GROUPING_STORAGE_KEY = 'oc.teamBoard.grouping.v1';

type BoardGroupingMode = 'status' | 'member';

const readStoredGrouping = (): BoardGroupingMode => {
  try {
    const raw = globalThis.localStorage.getItem(GROUPING_STORAGE_KEY);
    if (raw === 'status' || raw === 'member') return raw;
  } catch {
    // The default grouping stands until storage reads work.
  }
  return 'status';
};

type MemberVisual = { icon: IconName; color?: string };

const MEMBER_VISUALS: Record<TeamMember['status'], MemberVisual> = {
  busy: { icon: 'record-circle', color: 'var(--status-info)' },
  starting: { icon: 'record-circle', color: 'var(--status-info)' },
  idle: { icon: 'time' },
  failed: { icon: 'close-circle', color: 'var(--status-error)' },
  shut_down: { icon: 'checkbox-blank-circle' },
};

type TaskVisual = { icon: IconName; color?: string };

const TASK_VISUALS: Record<TeamTaskStatus, TaskVisual> = {
  in_progress: { icon: 'record-circle', color: 'var(--status-info)' },
  pending: { icon: 'time' },
  completed: { icon: 'checkbox-circle', color: 'var(--status-success)' },
};

const COLUMN_STATUSES: readonly TeamTaskStatus[] = ['pending', 'in_progress', 'completed'];

// The same stable order as the panel's task list: active work first, waiting
// behind it, finished last — cards do not jump as work happens.
const TASK_ORDER: Record<TeamTaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 };

const sortTasks = (tasks: readonly TeamTask[]): TeamTask[] =>
  [...tasks].sort((left, right) => TASK_ORDER[left.status] - TASK_ORDER[right.status] || right.createdAt - left.createdAt);

type Props = {
  sessionId: string | null;
  directory: string | null;
};

/**
 * The team's backlog over the same live data the panel section shows: either
 * the three status columns, or a column per teammate, chosen with the header
 * toggle and remembered across opens. The board is read-only by design — task
 * lifecycle belongs to the team's agents; this is where the user watches it
 * move. The roster strip above the columns keeps the same open-the-session
 * affordance the section rows already have.
 *
 * Rendered by both the dialog and the context-panel tab; it fills whatever
 * height the host gives it and scrolls its own columns.
 */
export const TeamBoardView: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const { board, loading } = useTeamBoard(sessionId);
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const [grouping, setGrouping] = React.useState<BoardGroupingMode>(readStoredGrouping);

  const openMemberSession = React.useCallback((member: TeamMember) => {
    if (!directory) return;
    if (isMobile || isVSCodeRuntime()) {
      setCurrentSession(member.sessionId, directory);
      return;
    }
    openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: `session:${member.sessionId}`,
      label: member.name,
      readOnly: true,
    });
  }, [directory, isMobile, openContextPanelTab, setCurrentSession]);

  const changeGrouping = React.useCallback((mode: BoardGroupingMode) => {
    setGrouping(mode);
    try {
      globalThis.localStorage.setItem(GROUPING_STORAGE_KEY, mode);
    } catch {
      // The mounted board keeps the choice for this open.
    }
  }, []);

  if (loading && !board) return null;
  if (!board) {
    // The team dissolved (or the fetch never saw it): say so instead of
    // leaving an empty frame the user reads as a load bug.
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        {t('chat.workStatus.teamBoard.teamGone')}
      </div>
    );
  }

  const nameOf = (slotId: string) => board.members.find((member) => member.slotId === slotId)?.name ?? slotId;

  const tasksByStatus = new Map<TeamTaskStatus, TeamTask[]>(
    COLUMN_STATUSES.map((status) => [status, sortTasks(board.tasks.filter((task) => task.status === status))]),
  );

  // A column per member, and one more for tasks without an owner on the
  // roster: those are the lead's to hand out, and hiding them would soften
  // the board's only early-warning signal.
  const memberColumns: Array<{ key: string; member: TeamMember | null; tasks: TeamTask[] }> = board.members.map((member) => ({
    key: member.slotId,
    member,
    tasks: sortTasks(board.tasks.filter((task) => task.owner === member.slotId)),
  }));
  const unownedTasks = sortTasks(board.tasks.filter((task) => !task.owner || !board.members.some((member) => member.slotId === task.owner)));
  if (unownedTasks.length > 0) memberColumns.push({ key: 'unassigned', member: null, tasks: unownedTasks });

  const describeTask = (task: TeamTask): string => [
    task.subject,
    task.description ?? undefined,
    [t(`chat.workStatus.teamBoard.status.${task.status}`), task.owner ? nameOf(task.owner) : undefined].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n');

  const renderCard = (task: TeamTask, showStatusIcon: boolean): React.ReactNode => {
    const visual = TASK_VISUALS[task.status];
    // Waiting only means something while the task still waits: a completed
    // card keeps its blockedBy history but must not read as blocked.
    const waiting = task.status === 'pending' && task.blockedBy.length > 0;
    return (
      <div
        key={task.taskId}
        title={describeTask(task)}
        className="rounded-lg border border-border bg-[var(--surface-muted)]/40 p-2 shadow-sm"
      >
        <div className="flex items-start gap-1.5">
          {showStatusIcon ? (
            <span className="mt-px flex size-4 shrink-0 items-center justify-center">
              <Icon name={visual.icon} className="size-3.5" style={visual.color ? { color: visual.color } : undefined} />
            </span>
          ) : null}
          <span className="line-clamp-3 text-[13px] text-foreground">{task.subject}</span>
        </div>
        {waiting || (!showStatusIcon && task.owner) ? (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] font-medium leading-4">
            {waiting ? (
              <span style={{ color: 'var(--status-warning)' }}>{t('chat.workStatus.team.blocked')}</span>
            ) : null}
            {!showStatusIcon && task.owner ? (
              <span className="truncate text-muted-foreground">{nameOf(task.owner)}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate typography-ui-header text-foreground">{board.name}</div>
          <div className="text-[11px] leading-4 text-muted-foreground">
            {t('chat.workStatus.teamBoard.subtitle', { members: board.members.length, tasks: board.tasks.length })}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border p-0.5" role="group">
          {(['status', 'member'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => changeGrouping(mode)}
              className={cn(
                'rounded-md px-2 py-1 text-[11px] font-medium leading-4 transition-colors',
                grouping === mode ? 'bg-[var(--interactive-hover)] text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={grouping === mode}
            >
              {t(mode === 'status' ? 'chat.workStatus.teamBoard.group.byStatus' : 'chat.workStatus.teamBoard.group.byMember')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {board.members.map((member) => {
          const visual = MEMBER_VISUALS[member.status];
          return (
            <button
              key={member.slotId}
              type="button"
              onClick={() => openMemberSession(member)}
              className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium leading-4 text-foreground transition-colors hover:bg-[var(--interactive-hover)]"
              title={t('chat.workStatus.team.openMember', { name: member.name })}
            >
              <Icon name={visual.icon} className="size-3.5" style={visual.color ? { color: visual.color } : undefined} />
              <span className="max-w-40 truncate">{member.name}</span>
              {member.unreadCount > 0 ? (
                <span
                  className="rounded-full px-1.5"
                  style={{ color: 'var(--status-info)', backgroundColor: 'color-mix(in srgb, var(--status-info) 18%, transparent)' }}
                >
                  {member.unreadCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="min-h-40 flex-1 overflow-auto">
        {board.tasks.length === 0 ? (
          <div className="flex h-full min-h-40 items-center justify-center text-[13px] text-muted-foreground">
            {t('chat.workStatus.teamBoard.emptyTasks')}
          </div>
        ) : (
          <div className="flex items-start gap-3">
            {grouping === 'status'
              ? COLUMN_STATUSES.map((status) => {
                const columnTasks = tasksByStatus.get(status) ?? [];
                const visual = TASK_VISUALS[status];
                return (
                  <div key={status} className="flex min-w-56 flex-1 basis-0 flex-col gap-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      <Icon name={visual.icon} className="size-3.5" style={visual.color ? { color: visual.color } : undefined} />
                      <span>{t(`chat.workStatus.teamBoard.status.${status}`)}</span>
                      <span>{columnTasks.length}</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {columnTasks.map((task) => renderCard(task, false))}
                    </div>
                  </div>
                );
              })
              : memberColumns.map(({ key, member, tasks }) => {
                const visual = member ? MEMBER_VISUALS[member.status] : null;
                const columnTitle = member?.name ?? t('chat.workStatus.teamBoard.unassigned');
                return (
                  <div key={key} className="flex min-w-56 flex-1 basis-0 flex-col gap-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {member ? (
                        <Icon
                          name={visual?.icon ?? 'checkbox-blank-circle'}
                          className="size-3.5"
                          style={visual?.color ? { color: visual.color } : undefined}
                        />
                      ) : null}
                      <span className="truncate">{columnTitle}</span>
                      <span>{tasks.length}</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {tasks.map((task) => renderCard(task, true))}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
};
