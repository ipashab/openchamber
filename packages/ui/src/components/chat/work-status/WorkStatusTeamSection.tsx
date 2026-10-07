import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useTeamBoard } from '@/hooks/useTeamBoard';
import { useTeamMemberColors } from '@/hooks/useTeamMemberColors';
import { fetchTeamBoards, TEAM_DOMAIN_LABEL_KEYS, type TeamMember, type TeamTask } from '@/lib/team/team-board-api';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { TeamBoardDialog } from './TeamBoardDialog';
import { TeamEditDialog } from '@/components/session/team/TeamEditDialog';

type Props = {
  sessionId: string | null;
  directory: string | null;
  /** Test seam: the real panel passes nothing and the route's fetch is used. */
  fetchTeamBoards?: typeof fetchTeamBoards;
};

const SECTION_ID = 'team';

type MemberVisual = { icon: IconName; color?: string; labelKey: I18nKey; tone: 'info' | 'muted' | 'error' };

type MemberVisuals = { [status in TeamMember['status']]: MemberVisual };

const MEMBER_VISUALS: MemberVisuals = {
  busy: { icon: 'record-circle', color: 'var(--status-info)', labelKey: 'chat.workStatus.team.working', tone: 'info' },
  starting: { icon: 'record-circle', color: 'var(--status-info)', labelKey: 'chat.workStatus.team.starting', tone: 'info' },
  idle: { icon: 'time', labelKey: 'chat.workStatus.team.idle', tone: 'muted' },
  failed: { icon: 'close-circle', color: 'var(--status-error)', labelKey: 'chat.workStatus.team.failed', tone: 'error' },
  shut_down: { icon: 'checkbox-blank-circle', labelKey: 'chat.workStatus.team.shutDown', tone: 'muted' },
};

const ROLE_LABEL_KEYS = {
  lead: 'chat.workStatus.team.role.lead',
  teammate: 'chat.workStatus.team.role.teammate',
} as const;

type TaskVisual = { icon: IconName; color?: string };

type TaskVisuals = { [status in TeamTask['status']]: TaskVisual };

const TASK_VISUALS: TaskVisuals = {
  in_progress: { icon: 'record-circle', color: 'var(--status-info)' },
  pending: { icon: 'time' },
  completed: { icon: 'checkbox-circle', color: 'var(--status-success)' },
};

// The board rows move as work happens; a stable order keeps them under the
// pointer. Active work first, waiting behind it, finished last.
type TaskOrder = { [status in TeamTask['status']]: number };

const TASK_ORDER: TaskOrder = { in_progress: 0, pending: 1, completed: 2 };

/**
 * The team this session belongs to: roster with live status, unread mail and
 * the shared task board. The lead and every teammate see the same picture.
 * Sessions not in a team render nothing, keeping the panel for their real work.
 */
export const WorkStatusTeamSection: React.FC<Props> = ({ sessionId, directory, fetchTeamBoards: fetcher }) => {
  const { t } = useI18n();
  const { board, loading } = useTeamBoard(sessionId, fetcher ? { fetchTeamBoards: fetcher } : {});
  const colorOf = useTeamMemberColors(board);
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setSectionExpanded = useUIStore((state) => state.setWorkStatusSectionExpanded);
  const [boardOpen, setBoardOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);

  // The panel tab is the primary opening: the board sits beside the chat
  // instead of covering it, and can be resized and re-opened like any other
  // surface. Mobile and VS Code keep the modal — the same split the member
  // rows already make when opening a session.
  const openBoard = React.useCallback(() => {
    if (!directory || !sessionId || isMobile || isVSCodeRuntime()) {
      setBoardOpen(true);
      return;
    }
    openContextPanelTab(directory, {
      mode: 'team',
      dedupeKey: `team:${sessionId}`,
      label: board?.name ?? t('chat.workStatus.teamBoard.title'),
    });
  }, [board?.name, directory, isMobile, openContextPanelTab, sessionId, t]);

  const present = board !== null;
  useReportWorkStatusPresence(SECTION_ID, present);

  // Same edge-triggered expansion as the subagents section: appearing where
  // there was nothing is the moment worth announcing, count changes are not.
  const hadBoard = React.useRef(present);
  React.useEffect(() => {
    if (present && !loading && !hadBoard.current) setSectionExpanded(SECTION_ID, true);
    hadBoard.current = present;
  }, [present, loading, setSectionExpanded]);

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

  if (!board) return null;

  const nameOf = (slotId: string) => board.members.find((member) => member.slotId === slotId)?.name ?? slotId;
  const busyMembers = board.members.filter((member) => member.status === 'busy' || member.status === 'starting').length;
  const tasks = [...board.tasks].sort((left, right) => TASK_ORDER[left.status] - TASK_ORDER[right.status] || right.createdAt - left.createdAt);

  return (
    <>
      <WorkStatusCollapsibleSection
        id={SECTION_ID}
        title={t('chat.workStatus.section.team')}
        icon="team"
        defaultExpanded
        summary={busyMembers > 0 ? `${busyMembers}/${board.members.length}` : board.members.length}
        action={(
          <div className="flex shrink-0 items-center">
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
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 text-muted-foreground"
              onClick={openBoard}
              aria-label={t('chat.workStatus.teamBoard.open')}
              title={t('chat.workStatus.teamBoard.open')}
            >
              <Icon name="layout-column" className="size-3.5" />
            </Button>
          </div>
        )}
      >
        <div className="max-h-56 overflow-y-auto">
        {board.members.map((member) => {
          const visual = MEMBER_VISUALS[member.status];
          const roleLabel = t(ROLE_LABEL_KEYS[member.role]);
          const domainParts = member.domain
            ? [
              t(TEAM_DOMAIN_LABEL_KEYS[member.domain]),
              member.isDomainLead ? t('chat.workStatus.team.domainLead') : null,
            ].filter(Boolean)
            : [];
          const roleTooltip = [roleLabel, ...domainParts].filter(Boolean).join(' · ');
          return (
            <WorkStatusRow
              key={member.slotId}
              onClick={() => openMemberSession(member)}
              ariaLabel={[t('chat.workStatus.team.openMember', { name: member.name }), roleTooltip, t(visual.labelKey)]
                .filter(Boolean)
                .join('. ')}
              leading={(
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <Icon name={visual.icon} className="size-3.5" style={visual.color ? { color: visual.color } : undefined} />
                </span>
              )}
              label={(
                <span className="font-medium" style={{ color: colorOf(member.slotId) ?? 'var(--foreground)' }}>{member.name}</span>
              )}
              tooltip={roleTooltip}
              value={(
                <>
                  {member.unreadCount > 0 ? (
                    <WorkStatusValue tone="info">{t('chat.workStatus.team.unread', { count: member.unreadCount })}</WorkStatusValue>
                  ) : null}
                  <WorkStatusValue tone={visual.tone}>{t(visual.labelKey)}</WorkStatusValue>
                </>
              )}
            />
          );
        })}
        {tasks.length > 0 ? (
          <>
            <div className="mt-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('chat.workStatus.team.tasks')}
            </div>
            {tasks.map((task) => {
              const visual = TASK_VISUALS[task.status];
              const blocked = task.status === 'pending' && task.blockedBy.length > 0;
              return (
                <WorkStatusRow
                  key={task.taskId}
                  leading={(
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <Icon name={visual.icon} className="size-3.5" style={visual.color ? { color: visual.color } : undefined} />
                    </span>
                  )}
                  label={task.subject}
                  tooltip={joinTaskTooltip(task, nameOf)}
                  value={(
                    <>
                      {blocked ? <WorkStatusValue tone="warning">{t('chat.workStatus.team.blocked')}</WorkStatusValue> : null}
                      {task.owner ? <WorkStatusValue tone="muted">{nameOf(task.owner)}</WorkStatusValue> : null}
                    </>
                  )}
                />
              );
            })}
          </>
        ) : null}
        </div>
      </WorkStatusCollapsibleSection>
      {boardOpen ? (
        <TeamBoardDialog
          open={boardOpen}
          onOpenChange={setBoardOpen}
          sessionId={sessionId}
          directory={directory}
        />
      ) : null}
      {editOpen ? (
        <TeamEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          board={board}
          directory={directory}
        />
      ) : null}
    </>
  );
};

// The tooltip carries what the row's value columns already truncate away.
const joinTaskTooltip = (task: TeamTask, nameOf: (slotId: string) => string): string =>
  [task.subject, task.owner ? `${nameOf(task.owner)} · ${task.status}` : task.status].join(' — ');
