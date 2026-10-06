import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import type { TeamTask, TeamTaskStatus } from '@/lib/team/team-board-api';

type TaskVisual = { icon: IconName; color?: string };

// Тот же набор иконок, что и у карточек доски: диалог продолжает визуальный
// язык доски, а не вводит свои обозначения статусов.
const TASK_VISUALS: Record<TeamTaskStatus, TaskVisual> = {
  in_progress: { icon: 'record-circle', color: 'var(--status-info)' },
  pending: { icon: 'time' },
  completed: { icon: 'checkbox-circle', color: 'var(--status-success)' },
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Задача живыми данными доски: родитель пересчитывает её на каждый рендер, поэтому статус в диалоге обновляется без переоткрытия. */
  task: TeamTask;
  /** slotId → отображаемое имя участника; чужие слоты выходят как есть. */
  nameOf: (slotId: string) => string;
  /** taskId → тема задачи; для зависимостей, которых уже нет на доске, — сам id. */
  subjectOf: (taskId: string) => string;
};

/**
 * Полный текст задачи по клику на её карточку: бриф лида (тот самый текст,
 * которым будят исполнителя), статус, владелец, зависимости и даты. Доска
 * остаётся местом обзора — три строки на карточку; детали живут здесь.
 */
export const TeamTaskDetailsDialog: React.FC<Props> = ({ open, onOpenChange, task, nameOf, subjectOf }) => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const visual = TASK_VISUALS[task.status];

  const formatStamp = (timestamp: number): string =>
    formatDateTimeForPreference(timestamp, timeFormatPreference, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  const blockedBy = task.blockedBy.map(subjectOf);

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
              task.owner ? nameOf(task.owner) : t('chat.workStatus.teamBoard.unassigned'),
              'owner',
            )}
            {task.createdBy
              ? metaRow(t('chat.workStatus.teamBoard.taskDetails.createdBy'), nameOf(task.createdBy), 'createdBy')
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
        </div>
      </DialogContent>
    </Dialog>
  );
};
