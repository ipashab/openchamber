import React from 'react';
import { useI18n } from '@/lib/i18n';
import { TeamBoardView } from './TeamBoardView';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  directory: string | null;
};

/**
 * The board as a modal over the current chat, for the runtimes where member
 * sessions also open as switches rather than panel tabs (mobile, VS Code).
 * Elsewhere the panel tab is the primary opening (see WorkStatusTeamSection):
 * it lives beside the chat instead of covering it. The body is shared.
 */
export const TeamBoardDialog: React.FC<Props> = ({ open, onOpenChange, sessionId, directory }) => {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-6xl flex-col gap-3 p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{t('chat.workStatus.teamBoard.title')}</DialogTitle>
        </DialogHeader>
        <TeamBoardView sessionId={sessionId} directory={directory} />
      </DialogContent>
    </Dialog>
  );
};
