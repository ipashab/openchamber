import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
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
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  createTeam,
  fetchTeamPresets,
  type TeamPreset,
  type TeamPresetMember,
} from '@/lib/team/team-create-api';
import { TeamMemberEditor } from './TeamMemberEditor';
import { useTeamEditorOptions } from './useTeamEditorOptions';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Mode = 'preset' | 'empty';

const blankMember = (): TeamPresetMember => ({
  name: '',
  agent: null,
  model: null,
  brief: null,
  skills: [],
  mcpServers: [],
  isLead: true,
});

/**
 * Create a team from the app: pick a preset (the recipe loads into the same
 * editor an empty team starts from) or compose one, and the dialog hands the
 * lineup to the server, which spawns the sessions and briefs the members.
 * It ends by opening the lead session — the chat the user steers the team
 * from — exactly the way a freshly sent draft session opens.
 */
export const NewTeamDialog: React.FC<Props> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const directory = useDirectoryStore((state) => state.currentDirectory);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const { agentOptions, modelOptions, skillOptions, mcpOptions, ensureLoaded } = useTeamEditorOptions(directory);

  const [mode, setMode] = React.useState<Mode>('preset');
  const [step, setStep] = React.useState<'choose' | 'edit'>('choose');
  const [presets, setPresets] = React.useState<TeamPreset[]>([]);
  const [teamName, setTeamName] = React.useState('');
  const [teamDescription, setTeamDescription] = React.useState('');
  const [task, setTask] = React.useState('');
  const [members, setMembers] = React.useState<TeamPresetMember[]>([blankMember()]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Every open starts from the same shelf: presets first, editor untouched.
  React.useEffect(() => {
    if (!open) return;
    setMode('preset');
    setStep('choose');
    setTeamName('');
    setTeamDescription('');
    setTask('');
    setMembers([blankMember()]);
    setError(null);
    let cancelled = false;
    fetchTeamPresets()
      .then((list) => { if (!cancelled) setPresets(list); })
      .catch(() => { if (!cancelled) setPresets([]); });
    ensureLoaded(directory);
    return () => { cancelled = true; };
  }, [open, directory, ensureLoaded]);

  const openPreset = (preset: TeamPreset) => {
    setTeamName(preset.name);
    setTeamDescription(preset.description ?? '');
    setMembers(preset.members.map((member) => ({
      name: member.name,
      agent: member.agent ?? null,
      model: member.model ?? null,
      brief: member.brief ?? null,
      skills: member.skills ?? [],
      mcpServers: member.mcpServers ?? [],
      isLead: member.isLead ?? false,
    })));
    setStep('edit');
  };

  const startEmpty = () => {
    setTeamName('');
    setTeamDescription('');
    setMembers([blankMember()]);
    setStep('edit');
  };

  const canSubmit = teamName.trim().length > 0 && members.length > 0 && members.every((member) => member.name.trim().length > 0);

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // The server folds an unflagged lineup onto its first member; sending
      // the same convention keeps both previews honest.
      const hasLead = members.some((member) => member.isLead);
      const result = await createTeam({
        name: teamName.trim(),
        description: teamDescription.trim() || null,
        directory,
        task: task.trim() || null,
        members: hasLead ? members : members.map((member, index) => ({ ...member, isLead: index === 0 })),
      });
      onOpenChange(false);
      setCurrentSession(result.leadSessionId, directory);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const chooseScreen = (
    <div className="space-y-2">
      {presets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('team.create.presets.empty')}
        </div>
      ) : presets.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => openPreset(preset)}
          className="w-full rounded-lg border border-border p-3 text-left transition-colors hover:bg-[var(--interactive-hover)]"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{preset.name}</span>
            {preset.builtIn ? (
              <span className="rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                {t('team.create.presets.builtIn')}
              </span>
            ) : null}
            <Icon name="arrow-right-s" className="ml-auto size-4 text-muted-foreground" />
          </div>
          {preset.description ? (
            <div className="mt-1 text-xs text-muted-foreground">{preset.description}</div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {preset.members.map((member) => (
              <span
                key={`${preset.id}-${member.name}`}
                className={cn(
                  'rounded-full border px-2 py-px text-[11px]',
                  member.isLead ? 'border-[var(--status-info)]/60 text-[var(--status-info)]' : 'border-border text-muted-foreground',
                )}
              >
                {member.name}
              </span>
            ))}
          </div>
        </button>
      ))}
      <Button type="button" variant="outline" size="sm" className="w-full" onClick={startEmpty}>
        <Icon name="add" className="size-3.5" />
        {t('team.create.empty')}
      </Button>
    </div>
  );

  const editScreen = (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('team.create.teamName.label')}
        </span>
        <Input
          value={teamName}
          onChange={(event) => setTeamName(event.target.value)}
          placeholder={t('team.create.teamName.placeholder')}
        />
      </div>
      <div className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('team.create.description.label')}
        </span>
        <Textarea
          value={teamDescription}
          onChange={(event) => setTeamDescription(event.target.value)}
          placeholder={t('team.create.description.placeholder')}
          rows={2}
          className="resize-none text-[13px]"
        />
      </div>
      <TeamMemberEditor
        members={members}
        onChange={setMembers}
        agentOptions={agentOptions}
        modelOptions={modelOptions}
        skillOptions={skillOptions}
        mcpOptions={mcpOptions}
      />
      <div className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('team.create.task.label')}
        </span>
        <Textarea
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder={t('team.create.task.placeholder')}
          rows={3}
          className="resize-none text-[13px]"
        />
      </div>
      <div className="text-[11px] text-muted-foreground">
        {t('team.create.directory.note', { directory })}
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(92vw,44rem)] flex-col sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{t('team.create.title')}</DialogTitle>
          <DialogDescription>{t('team.create.subtitle')}</DialogDescription>
        </DialogHeader>

        {step === 'choose' ? (
          <div className="inline-flex shrink-0 rounded-lg border border-border p-0.5">
            {(['preset', 'empty'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  if (option === 'preset') {
                    setMode('preset');
                    setStep('choose');
                  } else {
                    startEmpty();
                  }
                }}
                className={cn(
                  'rounded-md px-3 py-1 text-xs transition-colors',
                  (option === 'preset' ? mode === 'preset' : mode === 'empty')
                    ? 'bg-[var(--interactive-hover)] text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option === 'preset' ? t('team.create.mode.preset') : t('team.create.mode.empty')}
              </button>
            ))}
          </div>
        ) : null}

        <div className="oc-hide-scrollbar min-h-0 flex-1 overflow-y-auto py-2">
          {step === 'choose' ? chooseScreen : editScreen}
        </div>

        {error ? (
          <div className="shrink-0 rounded-md border border-[var(--status-error)]/50 px-2 py-1.5 text-xs text-[var(--status-error)]">
            {error}
          </div>
        ) : null}

        <div className="flex shrink-0 items-center justify-end gap-2 pt-2">
          {step === 'edit' && mode === 'preset' ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setStep('choose')}>
              {t('team.create.back')}
            </Button>
          ) : null}
          {step === 'edit' ? (
            <Button type="button" size="sm" disabled={!canSubmit || submitting} onClick={() => void submit()}>
              {submitting ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="team" className="size-3.5" />}
              {t('team.create.submit')}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
