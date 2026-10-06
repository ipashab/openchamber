import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  addTeamMember,
  downloadTeamPresetJson,
  fetchTeamPresetExport,
  requestTeamMemberShutdown,
  saveTeamPreset,
  type TeamCreateMember,
  type TeamPresetMember,
} from '@/lib/team/team-create-api';
import { TEAM_DOMAIN_LABEL_KEYS, type TeamBoard, type TeamMember } from '@/lib/team/team-board-api';
import { TeamMemberEditor } from './TeamMemberEditor';
import { useTeamEditorOptions } from './useTeamEditorOptions';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: TeamBoard | null;
  directory: string | null;
  /** Test seam: the real dialog passes nothing and the route's fetch is used. */
  addMember?: typeof addTeamMember;
  shutdownMember?: typeof requestTeamMemberShutdown;
  exportPreset?: typeof fetchTeamPresetExport;
  savePreset?: typeof saveTeamPreset;
};

type MemberVisual = { icon: IconName; color?: string };

const MEMBER_VISUALS: Record<TeamMember['status'], MemberVisual> = {
  busy: { icon: 'record-circle', color: 'var(--status-info)' },
  starting: { icon: 'record-circle', color: 'var(--status-info)' },
  idle: { icon: 'time' },
  failed: { icon: 'close-circle', color: 'var(--status-error)' },
  shut_down: { icon: 'checkbox-blank-circle' },
};

const blankMember = (): TeamPresetMember => ({
  name: '',
  agent: null,
  model: null,
  brief: null,
  skills: [],
  mcpServers: [],
  isLead: false,
  domain: null,
  isDomainLead: false,
});

/**
 * The editor of a live team's roster: the current members with their status
 * and a stop request each, plus the same member card the "New Team" dialog
 * composes lineups with — here the new card goes to the running team through
 * the add route, with the tool allowances the card carries. Stops ride the
 * same approval handshake the lead's shutdown tool uses; a busy member
 * answers when its turn ends.
 */
export const TeamEditDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  board,
  directory,
  addMember: addMemberImpl = addTeamMember,
  shutdownMember: shutdownMemberImpl = requestTeamMemberShutdown,
  exportPreset: exportPresetImpl = fetchTeamPresetExport,
  savePreset: savePresetImpl = saveTeamPreset,
}) => {
  const { t } = useI18n();
  const { agentOptions, modelOptions, skillOptions, mcpOptions, ensureLoaded } = useTeamEditorOptions(directory);
  const [newMembers, setNewMembers] = React.useState<TeamPresetMember[]>([blankMember()]);
  const [submitting, setSubmitting] = React.useState(false);
  const [stopPending, setStopPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [presetBusy, setPresetBusy] = React.useState(false);
  const [presetSaved, setPresetSaved] = React.useState(false);

  // Every open starts from a clean sheet: the roster itself is live data.
  React.useEffect(() => {
    if (!open) return;
    setNewMembers([blankMember()]);
    setError(null);
    setPresetSaved(false);
    ensureLoaded(directory);
    // ensureLoaded is stable; the directory the team works in is part of the
    // call, not of the effect's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, directory]);

  if (!board) return null;

  const domainLabel = (domain: TeamMember['domain']) => domain ? t(TEAM_DOMAIN_LABEL_KEYS[domain]) : null;

  const submitNewMembers = async () => {
    const rows = newMembers
      .map((member) => ({ ...member, name: member.name.trim() }))
      .filter((member) => member.name.length > 0);
    if (rows.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      for (const row of rows) {
        // The card is the route's input verbatim: the server validates the
        // agent and model against the live catalog and applies the tools.
        const member: TeamCreateMember = {
          name: row.name,
          agent: row.agent || null,
          model: row.model || null,
          brief: row.brief || null,
          skills: row.skills,
          mcpServers: row.mcpServers,
          domain: row.domain,
          isDomainLead: row.isDomainLead === true,
        };
        await addMemberImpl(board.id, member);
      }
      setNewMembers([blankMember()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const stopMember = async (member: TeamMember) => {
    if (stopPending || submitting) return;
    setStopPending(member.slotId);
    setError(null);
    try {
      await shutdownMemberImpl(board.id, member.slotId, t('team.edit.stopReason'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopPending(null);
    }
  };

  /**
   * The roster as a recipe: either straight onto the preset shelf, or as a
   * JSON file that imports back. The recipe is built server-side from the
   * briefs and tool allowances the board itself does not carry.
   */
  const exportRecipe = async (mode: 'save' | 'download') => {
    if (presetBusy) return;
    setPresetBusy(true);
    setError(null);
    try {
      const preset = await exportPresetImpl(board.id);
      if (mode === 'download') {
        downloadTeamPresetJson(preset);
      } else {
        // Preserve the server's fresh id: saving with it can never collide
        // with another recipe of the same name.
        await savePresetImpl(preset);
        setPresetSaved(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPresetBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="user-3" className="size-4 shrink-0" />
            <span className="truncate">{t('team.edit.title')}</span>
          </DialogTitle>
          <DialogDescription>{t('team.edit.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            {board.members.map((member) => {
              const visual = MEMBER_VISUALS[member.status];
              const domain = domainLabel(member.domain);
              const leadTag = member.isDomainLead ? t('team.create.member.domainLead') : null;
              const memberTitle = [member.name, domain, leadTag].filter(Boolean).join(' · ');
              const stoppable = member.role === 'teammate' && member.status !== 'shut_down';
              return (
                <div
                  key={member.slotId}
                  className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5"
                >
                  <Icon
                    name={visual.icon}
                    className="size-3.5 shrink-0"
                    style={visual.color ? { color: visual.color } : undefined}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px]" title={memberTitle}>
                    {member.name}
                    {domain ? <span className="text-muted-foreground"> · {domain}</span> : null}
                  </span>
                  {member.unreadCount > 0 ? (
                    <span
                      className="shrink-0 rounded-full px-1.5 text-[11px] font-medium leading-4"
                      style={{ color: 'var(--status-info)', backgroundColor: 'color-mix(in srgb, var(--status-info) 18%, transparent)' }}
                    >
                      {member.unreadCount}
                    </span>
                  ) : null}
                  {stoppable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5 text-xs text-muted-foreground"
                      disabled={stopPending !== null}
                      onClick={() => void stopMember(member)}
                      aria-label={t('team.edit.stop', { name: member.name })}
                      title={t('team.edit.stop', { name: member.name })}
                    >
                      <Icon name="close" className="size-3.5" />
                      {stopPending === member.slotId ? t('team.edit.stopping') : t('team.edit.stopShort')}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>

          <TeamMemberEditor
            members={newMembers}
            onChange={setNewMembers}
            agentOptions={agentOptions}
            modelOptions={modelOptions}
            skillOptions={skillOptions}
            mcpOptions={mcpOptions}
            allowLeadToggle={false}
          />

          {error ? (
            <div className="rounded-md border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 px-2.5 py-1.5 text-xs text-foreground">
              {error}
            </div>
          ) : null}

          <Button
            size="sm"
            className="w-full"
            disabled={submitting || !newMembers.some((member) => member.name.trim().length > 0)}
            onClick={() => void submitNewMembers()}
          >
            {submitting ? t('team.edit.adding') : t('team.edit.add')}
          </Button>

          <div className="space-y-2 rounded-lg border border-border p-2.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('team.edit.preset.title')}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={presetBusy}
                onClick={() => void exportRecipe('save')}
              >
                {presetBusy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                {t('team.edit.preset.save')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={presetBusy}
                onClick={() => void exportRecipe('download')}
              >
                {presetBusy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                {t('team.edit.preset.download')}
              </Button>
            </div>
            {presetSaved ? (
              <span className="block text-xs text-muted-foreground">{t('team.edit.preset.saved')}</span>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
