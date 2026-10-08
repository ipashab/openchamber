import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { openExternalUrl } from '@/lib/url';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import { setTeamTaskPull, type TeamPullSummary, type TeamTask, type TeamTaskStatus } from '@/lib/team/team-board-api';
import { TeamPullStateChip } from './TeamPullStateChip';

type TaskVisual = { icon: IconName; color?: string };

type TaskVisuals = { [status in TeamTaskStatus]: TaskVisual };

// Тот же набор иконок, что и у карточек доски: диалог продолжает визуальный
// язык доски, а не вводит свои обозначения статусов.
const TASK_VISUALS: TaskVisuals = {
  in_progress: { icon: 'record-circle', color: 'var(--status-info)' },
  pending: { icon: 'time' },
  completed: { icon: 'checkbox-circle', color: 'var(--status-success)' },
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Задача живыми данными доски: родитель пересчитывает её на каждый рендер, поэтому статус в диалоге обновляется без переоткрытия. */
  task: TeamTask;
  /** Команда задачи — адрес для записи ссылки на PR. */
  teamId: string;
  /** slotId → отображаемое имя участника; чужие слоты выходят как есть. */
  nameOf: (slotId: string) => string;
  /** slotId → identity-цвет участника; отсутствует — имя без подкраски. */
  colorOf?: (slotId: string) => string | undefined;
  /** taskId → тема задачи; для зависимостей, которых уже нет на доске, — сам id. */
  subjectOf: (taskId: string) => string;
  /** Живое состояние PR задачи; null — не разрешён (неизвестен) или отключён. */
  pullSummary: TeamPullSummary | null;
  /** false до первого ответа сервера состояний; затем его слово статуса. */
  pullLive: 'ok' | 'disconnected' | 'unavailable' | false;
};

/**
 * The task's full text behind a card click: the lead's brief (the same text
 * the owner was woken with), status, owner, dependencies and dates. The board
 * stays the overview surface — three lines per card; details live here.
 *
 * The pull-request row links the task to its reviewable work: live GitHub
 * state beside the link, and an inline edit to set or clear it. Saves go
 * through the same shape the agents' `team.task_update` prUrl parameter
 * accepts, so the user and the lead share one contract.
 */
export const TeamTaskDetailsDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  task,
  teamId,
  nameOf,
  colorOf,
  subjectOf,
  pullSummary,
  pullLive,
}) => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const visual = TASK_VISUALS[task.status];
  const [pullEditing, setPullEditing] = React.useState(false);
  const [pullDraft, setPullDraft] = React.useState('');
  const [pullSaving, setPullSaving] = React.useState(false);
  const [pullFailed, setPullFailed] = React.useState(false);

  // Fresh edit state for every open, and for every switch to another task
  // while the dialog stays open.
  React.useEffect(() => {
    if (open) {
      setPullEditing(false);
      setPullDraft('');
      setPullSaving(false);
      setPullFailed(false);
    }
  }, [open, task.taskId]);

  const savePull = async () => {
    if (pullSaving) return;
    setPullSaving(true);
    setPullFailed(false);
    try {
      await setTeamTaskPull(teamId, task.taskId, pullDraft.trim());
      // The board refetches through the broadcast this write carries; the
      // dialog reads the live task, so the row settles on its own.
      setPullEditing(false);
    } catch {
      setPullFailed(true);
    } finally {
      setPullSaving(false);
    }
  };

  const pull = task.pull;


  const formatStamp = (timestamp: number): string =>
    formatDateTimeForPreference(timestamp, timeFormatPreference, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  const blockedBy = task.blockedBy.map(subjectOf);

  // Чужие слоты (участник покинул команду) выходят без цвета: подкраска имени
  // — подсказка «чей это», а не признак действующего состава.
  const memberName = (slotId: string): React.ReactNode => {
    const color = colorOf?.(slotId);
    return color ? <span style={{ color }}>{nameOf(slotId)}</span> : nameOf(slotId);
  };

  const metaRow = (label: string, value: React.ReactNode, key: string) => (
    <div key={key} className="flex min-w-0 items-baseline gap-2 text-[13px]">
      <span className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-foreground">{value}</span>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2">
            <Icon
              name={visual.icon}
              className="mt-0.5 size-4 shrink-0"
              style={visual.color ? { color: visual.color } : undefined}
            />
            <span className="break-words">{task.subject}</span>
          </DialogTitle>
          <DialogDescription>{t('chat.workStatus.teamBoard.taskDetails.title')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            {metaRow(
              t('chat.workStatus.teamBoard.taskDetails.status'),
              t(`chat.workStatus.teamBoard.status.${task.status}`),
              'status',
            )}
            {metaRow(
              t('chat.workStatus.teamBoard.taskDetails.owner'),
              task.owner ? memberName(task.owner) : t('chat.workStatus.teamBoard.unassigned'),
              'owner',
            )}
            {task.createdBy
              ? metaRow(t('chat.workStatus.teamBoard.taskDetails.createdBy'), memberName(task.createdBy), 'createdBy')
              : null}
            {blockedBy.length > 0
              ? metaRow(t('chat.workStatus.teamBoard.taskDetails.blockedBy'), blockedBy.join(', '), 'blockedBy')
              : null}
            {metaRow(t('chat.workStatus.teamBoard.taskDetails.createdAt'), formatStamp(task.createdAt), 'createdAt')}
            {task.updatedAt !== task.createdAt
              ? metaRow(t('chat.workStatus.teamBoard.taskDetails.updatedAt'), formatStamp(task.updatedAt), 'updatedAt')
              : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
              <span className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('chat.workStatus.teamBoard.taskDetails.pullRequest')}
              </span>
              <span className="flex min-w-0 flex-1 items-center flex-wrap gap-1.5">
                {pull && !pullEditing ? (
                  <>
                    <TeamPullStateChip pull={pull} summary={pullSummary} live={pullLive} />
                    <button
                      type="button"
                      className="shrink-0 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => void openExternalUrl(pull.url)}
                    >
                      {t('chat.workStatus.teamBoard.taskDetails.openPull')}
                    </button>
                  </>
                ) : !pullEditing ? (
                  <span className="text-[13px] text-muted-foreground">{t('chat.workStatus.teamBoard.taskDetails.noPull')}</span>
                ) : null}
                {!pullEditing ? (
                  <button
                    type="button"
                    className="shrink-0 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => { setPullDraft(pull?.url ?? ''); setPullFailed(false); setPullEditing(true); }}
                  >
                    {pull
                      ? t('chat.workStatus.teamBoard.taskDetails.changePull')
                      : t('chat.workStatus.teamBoard.taskDetails.addPull')}
                  </button>
                ) : null}
              </span>
            </div>
            {pullEditing ? (
              <div className="space-y-1.5 pl-28">
                <Input
                  value={pullDraft}
                  onChange={(event) => setPullDraft(event.target.value)}
                  placeholder="https://github.com/<owner>/<repo>/pull/<number>"
                  aria-label={t('chat.workStatus.teamBoard.taskDetails.pullUrlLabel')}
                  autoFocus
                />
                {pullFailed ? (
                  <p role="alert" className="text-[13px]" style={{ color: 'var(--status-error)' }}>
                    {t('chat.workStatus.teamBoard.taskDetails.pullSaveError')}
                  </p>
                ) : null}
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" disabled={pullSaving} onClick={() => void savePull()}>
                    {t('chat.workStatus.teamBoard.taskDetails.pullSave')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pullSaving || !pull}
                    onClick={() => { setPullDraft(''); void savePull(); }}
                  >
                    {t('chat.workStatus.teamBoard.taskDetails.pullClear')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pullSaving}
                    onClick={() => setPullEditing(false)}
                  >
                    {t('chat.workStatus.teamBoard.addTask.cancel')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('chat.workStatus.teamBoard.taskDetails.brief')}
            </div>
            {task.description
              ? (
                <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-[var(--surface-muted)]/40 px-2.5 py-2 text-[13px] text-foreground">
                  {task.description}
                </div>
              )
              : (
                <div className="rounded-lg border border-border px-2.5 py-2 text-[13px] text-muted-foreground">
                  {t('chat.workStatus.teamBoard.taskDetails.noBrief')}
                </div>
              )}
          </div>

          {task.status === 'completed' ? (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('chat.workStatus.teamBoard.taskDetails.result')}
              </div>
              {task.result ? (
                <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-[var(--surface-muted)]/40 px-2.5 py-2 text-[13px] text-foreground">
                  {task.result}
                </div>
              ) : (
                <div className="rounded-lg border border-border px-2.5 py-2 text-[13px] text-muted-foreground">
                  {t('chat.workStatus.teamBoard.taskDetails.noResult')}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
