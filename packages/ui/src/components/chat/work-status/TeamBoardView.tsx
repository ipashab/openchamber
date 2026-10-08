import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useTeamBoard } from '@/hooks/useTeamBoard';
import { useTeamMemberColors } from '@/hooks/useTeamMemberColors';
import { useTeamPullSummaries } from '@/hooks/useTeamPullSummaries';
import {
  readTeamBoardView,
  writeTeamBoardView,
  type TeamBoardViewMode,
} from '@/lib/team/teamBoardViewPrefs';
import {
  TEAM_DOMAIN_IDS,
  TEAM_DOMAIN_LABEL_KEYS,
  type TeamMember,
  type TeamTask,
  type TeamTaskStatus,
} from '@/lib/team/team-board-api';
import { TeamEditDialog } from '@/components/session/team/TeamEditDialog';
import { TeamAddTaskDialog } from './TeamAddTaskDialog';
import { TeamPullStateChip } from './TeamPullStateChip';
import { TeamTaskDetailsDialog } from './TeamTaskDetailsDialog';
import { TeamActivityView } from './TeamActivityView';

const GROUPING_STORAGE_KEY = 'oc.teamBoard.grouping.v1';

type BoardGroupingMode = 'status' | 'member' | 'domain';

const readStoredGrouping = (): BoardGroupingMode => {
  try {
    const raw = globalThis.localStorage.getItem(GROUPING_STORAGE_KEY);
    if (raw === 'status' || raw === 'member' || raw === 'domain') return raw;
  } catch {
    // The default grouping stands until storage reads work.
  }
  return 'status';
};

type MemberVisual = { icon: IconName; color?: string };

/** Один визуал на каждый живой статус участника — закрытый словарь, не Record. */
type MemberVisuals = { [status in TeamMember['status']]: MemberVisual };

const MEMBER_VISUALS: MemberVisuals = {
  busy: { icon: 'record-circle', color: 'var(--status-info)' },
  starting: { icon: 'record-circle', color: 'var(--status-info)' },
  idle: { icon: 'time' },
  failed: { icon: 'close-circle', color: 'var(--status-error)' },
  shut_down: { icon: 'checkbox-blank-circle' },
};

type TaskVisual = { icon: IconName; color?: string };

type TaskVisuals = { [status in TeamTaskStatus]: TaskVisual };

const TASK_VISUALS: TaskVisuals = {
  in_progress: { icon: 'record-circle', color: 'var(--status-info)' },
  pending: { icon: 'time' },
  completed: { icon: 'checkbox-circle', color: 'var(--status-success)' },
};

const COLUMN_STATUSES: readonly TeamTaskStatus[] = ['pending', 'in_progress', 'completed'];

// The same stable order as the panel's task list: active work first, waiting
// behind it, finished last — cards do not jump as work happens.
type TaskOrder = { [status in TeamTaskStatus]: number };

const TASK_ORDER: TaskOrder = { in_progress: 0, pending: 1, completed: 2 };

const sortTasks = (tasks: readonly TeamTask[]): TeamTask[] =>
  [...tasks].sort((left, right) => TASK_ORDER[left.status] - TASK_ORDER[right.status] || right.createdAt - left.createdAt);

type Props = {
  sessionId: string | null;
  directory: string | null;
  /**
   * Renders one member's chat column for the "Chats" face of a team tab.
   * Injected by the context panel because a direct ChatView import would
   * close a module cycle (ChatContainer renders the work-status panel, whose
   * team section renders this view). Hosts without the injection — the
   * mobile/VS Code dialog — show board and activity only.
   */
  chatColumn?: (member: TeamMember, directory: string) => React.ReactNode;
};

/**
 * The team over the same live data the panel section shows, in three faces:
 * the task board — the three status columns, a column per teammate, or a
 * column per sub-team with its lead named, chosen with the header grouping
 * toggle and remembered across opens — the parallel chat columns of the whole
 * roster (desktop context panel; injected by the host) — and the activity
 * feed, the mailbox and the task board merged newest first, paged into
 * retained history on demand. The faces stay read-only; the one write is the
 * board quick-add — a task the user files without asking the lead to relay
 * it — which follows the same assignment semantics the lead's own tool path
 * uses. Task lifecycle and member briefings otherwise belong to the team's
 * agents; this is where the user watches them move. The roster strip above
 * the columns keeps the same open-the-session affordance the section rows
 * already have; the chat columns and the feed are the faces where it is
 * carried by their own rows.
 *
 * Rendered by both the dialog and the context-panel tab; it fills whatever
 * height the host gives it and scrolls its own columns. The header also
 * opens the live-roster editor dialog.
 */
export const TeamBoardView: React.FC<Props> = ({ sessionId, directory, chatColumn }) => {
  const { t } = useI18n();
  const { board, loading } = useTeamBoard(sessionId);
  const colorOf = useTeamMemberColors(board);
  // Live GitHub state for the PR chips; a board without linked PRs never
  // talks to the provider.
  const hasPulls = board?.tasks.some((task) => task.pull != null) ?? false;
  const { summaries: pullSummaries, live: pullLive } = useTeamPullSummaries(board?.id ?? '', hasPulls);
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const [grouping, setGrouping] = React.useState<BoardGroupingMode>(readStoredGrouping);
  // Board and chats are per-team choices; the state carries the team it was
  // read for, so a late-arriving board re-reads its own preference.
  const [view, setView] = React.useState<{ teamId: string; mode: TeamBoardViewMode }>({ teamId: '', mode: 'board' });
  const [editOpen, setEditOpen] = React.useState(false);
  const [addTaskOpen, setAddTaskOpen] = React.useState(false);
  const [detailTaskId, setDetailTaskId] = React.useState<string | null>(null);

  if (board && view.teamId !== board.id) {
    setView({ teamId: board.id, mode: readTeamBoardView(board.id) });
  }

  const changeView = React.useCallback((mode: TeamBoardViewMode) => {
    setView((current) => {
      if (current.mode !== mode) writeTeamBoardView(current.teamId, mode);
      return { ...current, mode };
    });
  }, []);

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

  // 'user' is the app's pseudo-id on tasks the user added themselves; where a
  // slotId would name a teammate, this reads as "You" instead.
  const nameOf = (slotId: string) => slotId === 'user'
    ? t('chat.workStatus.teamBoard.you')
    : board.members.find((member) => member.slotId === slotId)?.name ?? slotId;

  // Клик по карточке открывает диалог; данные берутся с доски на каждом
  // рендере, поэтому статус в открытом диалоге живёт вместе с доской.
  const subjectOf = (taskId: string) => board.tasks.find((entry) => entry.taskId === taskId)?.subject ?? taskId;
  const detailTask = detailTaskId ? board.tasks.find((task) => task.taskId === detailTaskId) ?? null : null;

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

  // Sub-team columns: one per domain the roster actually carries, the
  // domain's tasks under its lead's name, plus the no-domain and unassigned
  // buckets the member grouping has. Empty domains stay hidden — the board
  // shows the sub-teams that exist, not the catalog.
  const memberBySlot = new Map(board.members.map((member) => [member.slotId, member]));
  type DomainColumn = { key: string; domain: TeamMember['domain']; lead: TeamMember | null; tasks: TeamTask[] };
  const domainColumns: DomainColumn[] = [];
  for (const domain of TEAM_DOMAIN_IDS) {
    const next: DomainColumn = {
      key: domain,
      domain,
      lead: board.members.find((member) => member.domain === domain && member.isDomainLead === true) ?? null,
      tasks: sortTasks(board.tasks.filter((task) => memberBySlot.get(task.owner ?? '')?.domain === domain)),
    };
    const carries = board.members.some((member) => member.domain === domain) || next.tasks.length > 0;
    // Tasks nobody on the roster owns still belong to their domain visually:
    // they were dispatched to a domain lead, not to a stranger.
    if (carries) domainColumns.push(next);
  }
  const noDomainTasks = sortTasks(board.tasks.filter((task) => {
    const owner = memberBySlot.get(task.owner ?? '');
    return owner != null && owner.domain == null;
  }));
  if (board.members.some((member) => member.domain == null && member.role === 'teammate') && noDomainTasks.length > 0) {
    domainColumns.push({ key: 'nodomain', domain: null, lead: null, tasks: noDomainTasks });
  }
  if (unownedTasks.length > 0) {
    domainColumns.push({ key: 'unassigned', domain: null, lead: null, tasks: unownedTasks });
  }

  // The roster strip reads as an org chart when sub-teams exist: the Team
  // Lead first, then each domain lead ahead of its mates, undomained last.
  const rosterOrder = (() => {
    if (!board.members.some((member) => member.domain != null)) return board.members;
    const byDomain = (left: TeamMember, right: TeamMember) => {
      const index = (member: TeamMember) => member.domain == null ? TEAM_DOMAIN_IDS.length : TEAM_DOMAIN_IDS.indexOf(member.domain);
      const leadFirst = (a: TeamMember, b: TeamMember) => (Number(b.isDomainLead === true) - Number(a.isDomainLead === true));
      return index(left) - index(right) || leadFirst(left, right);
    };
    const leadMembers = board.members.filter((member) => member.role === 'lead');
    const domainMembers = board.members.filter((member) => member.role === 'teammate' && member.domain != null).sort(byDomain);
    const plainMembers = board.members.filter((member) => member.role === 'teammate' && member.domain == null);
    return [...leadMembers, ...domainMembers, ...plainMembers];
  })();

  const describeTask = (task: TeamTask): string => [
    task.subject,
    task.description ?? undefined,
    // The finished task carries its answer; the tooltip is the one-glance
    // view before the click opens the full details.
    task.status === 'completed' && task.result ? task.result : undefined,
    [t(`chat.workStatus.teamBoard.status.${task.status}`), task.owner ? nameOf(task.owner) : undefined].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n');

  const renderCard = (task: TeamTask, showStatusIcon: boolean): React.ReactNode => {
    const visual = TASK_VISUALS[task.status];
    // Waiting only means something while the task still waits: a completed
    // card keeps its blockedBy history but must not read as blocked.
    const waiting = task.status === 'pending' && task.blockedBy.length > 0;
    return (
      <button
        type="button"
        key={task.taskId}
        title={describeTask(task)}
        onClick={() => setDetailTaskId(task.taskId)}
        className="rounded-lg border border-border bg-[var(--surface-muted)]/40 p-2 text-left shadow-sm transition-colors hover:bg-[var(--surface-muted)]/70 focus-visible:outline-2 focus-visible:outline-offset-1"
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
              <span className="truncate font-medium" style={{ color: colorOf(task.owner) ?? 'var(--muted-foreground)' }}>{nameOf(task.owner)}</span>
            ) : null}
          </div>
        ) : null}
        {task.pull ? (
          <div className="mt-1">
            <TeamPullStateChip pull={task.pull} summary={pullSummaries?.[task.taskId] ?? null} live={pullLive} />
          </div>
        ) : null}
      </button>
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
        <div className="flex shrink-0 items-center gap-2">
          {chatColumn && view.mode === 'chats' ? null : (
            <div className="flex items-center gap-1 rounded-lg border border-border p-0.5" role="group">
              {(['status', 'member', 'domain'] as const).map((mode) => (
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
                  {t(mode === 'status'
                    ? 'chat.workStatus.teamBoard.group.byStatus'
                    : mode === 'member'
                      ? 'chat.workStatus.teamBoard.group.byMember'
                      : 'chat.workStatus.teamBoard.group.byDomain')}
                </button>
              ))}
            </div>
          )}
          {/* Chats ride the host-injected columns; board and activity are the
              faces every runtime can render. */}
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5" role="group">
            {(chatColumn ? (['board', 'chats', 'activity'] as const) : (['board', 'activity'] as const)).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => changeView(mode)}
                  className={cn(
                    'rounded-md px-2 py-1 text-[11px] font-medium leading-4 transition-colors',
                    view.mode === mode ? 'bg-[var(--interactive-hover)] text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                  aria-pressed={view.mode === mode}
                >
                  {t(`chat.workStatus.teamBoard.view.${mode}`)}
                </button>
              ))}
          </div>
          {/* The quick-add belongs to the board face; the chats and activity
              faces show what the team already does, not what to file next. */}
          {view.mode === 'board' ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 text-muted-foreground"
              onClick={() => setAddTaskOpen(true)}
              aria-label={t('chat.workStatus.teamBoard.addTask.button')}
              title={t('chat.workStatus.teamBoard.addTask.button')}
            >
              <Icon name="add" className="size-3.5" />
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 text-muted-foreground"
            onClick={() => setEditOpen(true)}
            aria-label={t('team.edit.title')}
            title={t('team.edit.title')}
          >
            <Icon name="user-3" className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* The roster chips belong to the board face; chats carry the member in
          each column header and activity in the rows themselves. */}
      {view.mode === 'chats' && chatColumn ? null : view.mode === 'activity' ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
        {rosterOrder.map((member) => {
          const visual = MEMBER_VISUALS[member.status];
          const domainLabel = member.domain ? t(TEAM_DOMAIN_LABEL_KEYS[member.domain]) : null;
          const chipTitle = [
            t('chat.workStatus.team.openMember', { name: member.name }),
            domainLabel,
            member.isDomainLead ? t('chat.workStatus.team.domainLead') : null,
          ].filter(Boolean).join(' · ');
          return (
            <button
              key={member.slotId}
              type="button"
              onClick={() => openMemberSession(member)}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors hover:bg-[var(--interactive-hover)]',
                member.domain ? 'border-transparent text-foreground' : 'border-border text-foreground',
              )}
              style={member.domain ? {
                backgroundColor: member.isDomainLead
                  ? 'color-mix(in srgb, var(--status-info) 14%, transparent)'
                  : 'color-mix(in srgb, var(--status-info) 7%, transparent)',
              } : undefined}
              title={chipTitle}
            >
              <Icon name={visual.icon} className="size-3.5" style={visual.color ? { color: visual.color } : undefined} />
              <span className="max-w-40 truncate font-medium" style={{ color: colorOf(member.slotId) ?? 'var(--foreground)' }}>{member.name}</span>
              {domainLabel ? <span className="max-w-24 truncate text-muted-foreground">{domainLabel}</span> : null}
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
      )}

      {view.mode === 'activity' ? (
        <TeamActivityView
          board={board}
          colorOf={colorOf}
          nameOf={nameOf}
        />
      ) : view.mode === 'chats' && chatColumn ? (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="flex h-full min-h-0 items-stretch gap-2">
            {rosterOrder.map((member) => {
              const visual = MEMBER_VISUALS[member.status];
              const domainLabel = member.domain ? t(TEAM_DOMAIN_LABEL_KEYS[member.domain]) : null;
              return (
                <div key={member.slotId} className="flex h-full min-h-0 min-w-72 flex-1 basis-72 flex-col gap-1.5">
                  {/* The column header carries the roster chip's affordance: identity
                      hue, live status, team mail — click opens the full chat tab. */}
                  <button
                    type="button"
                    onClick={() => openMemberSession(member)}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-[var(--surface-elevated)] px-2 py-1 text-left text-[11px] font-medium leading-4 transition-colors hover:bg-[var(--interactive-hover)]"
                    title={[
                      t('chat.workStatus.team.openMember', { name: member.name }),
                      domainLabel,
                      member.isDomainLead ? t('chat.workStatus.team.domainLead') : null,
                    ].filter(Boolean).join(' · ')}
                  >
                    <Icon name={visual.icon} className="size-3.5 shrink-0" style={visual.color ? { color: visual.color } : undefined} />
                    <span className="min-w-0 flex-1 truncate" style={{ color: colorOf(member.slotId) ?? 'var(--foreground)' }}>{member.name}</span>
                    {member.unreadCount > 0 ? (
                      <span
                        className="shrink-0 rounded-full px-1.5"
                        style={{ color: 'var(--status-info)', backgroundColor: 'color-mix(in srgb, var(--status-info) 18%, transparent)' }}
                      >
                        {member.unreadCount}
                      </span>
                    ) : null}
                  </button>
                  <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
                    {chatColumn(member, board.directory)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
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
              : grouping === 'member'
                ? memberColumns.map(({ key, member, tasks }) => {
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
                        <span className="truncate" style={member ? { color: colorOf(member.slotId) } : undefined}>{columnTitle}</span>
                        <span>{tasks.length}</span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {tasks.map((task) => renderCard(task, true))}
                      </div>
                    </div>
                  );
                })
                : domainColumns.map(({ key, domain, lead, tasks }) => {
                  return (
                    <div key={key} className="flex min-w-56 flex-1 basis-0 flex-col gap-2">
                      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {domain ? (
                          <span className="truncate">
                            {t(TEAM_DOMAIN_LABEL_KEYS[domain])}
                            {lead ? (
                              <>
                                {' · '}
                                <span style={{ color: colorOf(lead.slotId) }}>{lead.name}</span>
                              </>
                            ) : null}
                          </span>
                        ) : (
                          <span className="truncate">{t(key === 'unassigned' ? 'chat.workStatus.teamBoard.unassigned' : 'chat.workStatus.teamBoard.noDomain')}</span>
                        )}
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
      )}

      {editOpen ? (
        <TeamEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          board={board}
          directory={directory}
        />
      ) : null}

      {addTaskOpen ? (
        <TeamAddTaskDialog
          open
          onOpenChange={setAddTaskOpen}
          board={board}
        />
      ) : null}

      {detailTask ? (
        <TeamTaskDetailsDialog
          open
          onOpenChange={(next) => { if (!next) setDetailTaskId(null); }}
          task={detailTask}
          teamId={board.id}
          nameOf={nameOf}
          colorOf={colorOf}
          subjectOf={subjectOf}
          pullSummary={pullSummaries?.[detailTask.taskId] ?? null}
          pullLive={pullLive}
        />
      ) : null}
    </div>
  );
};
