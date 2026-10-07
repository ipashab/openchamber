import React from 'react';

import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createTeamTask, type TeamBoard } from '@/lib/team/team-board-api';

// The "leave it unassigned" entry of the owner select; Base UI prints the
// raw value when the item carries no children, so the sentinel maps back to
// the translated label instead of leaking into the trigger.
const UNASSIGNED_VALUE = '__none__';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The live board the dialog adds to — the roster is the owner picker. */
  board: TeamBoard;
};

/**
 * The board's quick-add: the user puts a task on the board themselves,
 * instead of asking the lead to relay it. The subject is the whole task;
 * the brief is optional context for whoever picks it up — the tooltip on
 * the card and the wake prompt both carry it. An owner, if picked, follows
 * the lead's own assignment semantics: the mailbox entry notifies and the
 * wake carries the details. No owner means the task sits in the unassigned
 * column until the lead hands it out.
 */
export const TeamAddTaskDialog: React.FC<Props> = ({ open, onOpenChange, board }) => {
  const { t } = useI18n();
  const [subject, setSubject] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [owner, setOwner] = React.useState<string>(UNASSIGNED_VALUE);
  const [submitting, setSubmitting] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  // Fresh fields for every open; a submitted task is on the board, and the
  // next one should not start from its text.
  React.useEffect(() => {
    if (open) {
      setSubject('');
      setDescription('');
      setOwner(UNASSIGNED_VALUE);
      setSubmitting(false);
      setFailed(false);
    }
  }, [open]);

  // The lead coordinates the board and never owns a task; the picker lists
  // teammates only.
  const teammates = board.members.filter((member) => member.role === 'teammate');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = subject.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setFailed(false);
    try {
      await createTeamTask(board.id, {
        subject: trimmed,
        description: description.trim() || undefined,
        owner: owner === UNASSIGNED_VALUE ? undefined : owner,
      });
      onOpenChange(false);
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('chat.workStatus.teamBoard.addTask.title')}</DialogTitle>
          <DialogDescription>{t('chat.workStatus.teamBoard.addTask.description')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => void submit(event)}>
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('chat.workStatus.teamBoard.addTask.subject')}
            </span>
            <Input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder={t('chat.workStatus.teamBoard.addTask.subjectPlaceholder')}
              autoFocus
              aria-label={t('chat.workStatus.teamBoard.addTask.subject')}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('chat.workStatus.teamBoard.addTask.brief')}
            </span>
            <Textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('chat.workStatus.teamBoard.addTask.briefPlaceholder')}
              aria-label={t('chat.workStatus.teamBoard.addTask.brief')}
            />
          </label>
          {teammates.length > 0 ? (
            <div className="space-y-1.5">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('chat.workStatus.teamBoard.addTask.owner')}
              </span>
              <Select
                value={owner}
                onValueChange={setOwner}
                items={[
                  { value: UNASSIGNED_VALUE, label: t('chat.workStatus.teamBoard.unassigned') },
                  ...teammates.map((member) => ({ value: member.slotId, label: member.name })),
                ]}
              >
                <SelectTrigger size="sm" className="h-8 w-full" aria-label={t('chat.workStatus.teamBoard.addTask.owner')}>
                  <SelectValue>
                    {owner === UNASSIGNED_VALUE
                      ? t('chat.workStatus.teamBoard.unassigned')
                      : teammates.find((member) => member.slotId === owner)?.name ?? owner}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED_VALUE}>{t('chat.workStatus.teamBoard.unassigned')}</SelectItem>
                  {teammates.map((member) => (
                    <SelectItem key={member.slotId} value={member.slotId}>{member.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {failed ? (
            <p role="alert" className="text-[13px]" style={{ color: 'var(--status-error)' }}>
              {t('chat.workStatus.teamBoard.addTask.error')}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('chat.workStatus.teamBoard.addTask.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={subject.trim().length === 0 || submitting}
            >
              {t('chat.workStatus.teamBoard.addTask.submit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
