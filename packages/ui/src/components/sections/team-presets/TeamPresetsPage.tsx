import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsCard,
  SettingsCardChip,
  SettingsCardIcon,
} from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { TeamMemberEditor } from '@/components/session/team/TeamMemberEditor';
import { useTeamEditorOptions } from '@/components/session/team/useTeamEditorOptions';
import {
  deleteTeamPreset,
  fetchTeamPresets,
  saveTeamPreset,
  type TeamPreset,
} from '@/lib/team/team-create-api';

const blankPreset = (): TeamPreset => ({
  id: '',
  name: '',
  description: null,
  members: [{ name: '', agent: null, model: null, brief: null, skills: [], mcpServers: [], isLead: true }],
});

/**
 * Editing one preset: the same roster editor the "New Team" dialog uses, so
 * a recipe looks exactly like the team it seeds. Saving a built-in stores a
 * copy — the server moves it to a fresh id — which is also how "duplicate"
 * works for a recipe the user only wants to tweak once.
 */
const PresetEditorDialog: React.FC<{
  preset: TeamPreset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}> = ({ preset, open, onOpenChange, onSaved }) => {
  const { t } = useI18n();
  const directory = useDirectoryStore((state) => state.currentDirectory);
  const { agentOptions, modelOptions, skillOptions, mcpOptions, ensureLoaded } = useTeamEditorOptions(directory);
  const [name, setName] = React.useState(preset.name);
  const [description, setDescription] = React.useState(preset.description ?? '');
  const [members, setMembers] = React.useState(preset.members);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName(preset.name);
    setDescription(preset.description ?? '');
    setMembers(preset.members);
    setError(null);
    ensureLoaded(directory);
  }, [open, preset, directory, ensureLoaded]);

  const builtIn = preset.builtIn === true;
  const canSave = name.trim().length > 0 && members.length > 0 && members.every((member) => member.name.trim().length > 0);

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveTeamPreset({
        // An empty id asks the store for a fresh one; a built-in id makes the
        // store answer with a copy instead of overwriting the shipped recipe.
        id: builtIn ? preset.id : (preset.id || undefined),
        name: name.trim(),
        description: description.trim() || null,
        members,
      } as TeamPreset);
      onOpenChange(false);
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(92vw,44rem)] flex-col sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{builtIn ? t('settings.teams.editor.copyTitle') : t('settings.teams.editor.title')}</DialogTitle>
          <DialogDescription>{t('settings.teams.editor.description')}</DialogDescription>
        </DialogHeader>
        <div className="oc-hide-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto py-2">
          <div className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('team.create.teamName.label')}
            </span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('team.create.teamName.placeholder')} />
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('team.create.description.label')}
            </span>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
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
        </div>
        {error ? (
          <div className="shrink-0 rounded-md border border-[var(--status-error)]/50 px-2 py-1.5 text-xs text-[var(--status-error)]">
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('team.create.cancel')}
          </Button>
          <Button type="button" size="sm" disabled={!canSave || saving} onClick={() => void save()}>
            {saving ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {t('settings.teams.editor.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Settings page for team presets: the shelf the "New Team" dialog offers.
 * Built-in recipes are read-only but editable as a copy; the user's own are
 * editable and deletable here.
 */
export const TeamPresetsPage: React.FC = () => {
  const { t } = useI18n();
  const [presets, setPresets] = React.useState<TeamPreset[]>([]);
  const [editing, setEditing] = React.useState<TeamPreset | null>(null);
  const [deleting, setDeleting] = React.useState<TeamPreset | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      setPresets(await fetchTeamPresets());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  React.useEffect(() => { void reload(); }, [reload]);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteTeamPreset(deleting.id);
      setDeleting(null);
      void reload();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      setDeleting(null);
    }
  };

  return (
    <SettingsPageLayout title={t('settings.teams.title')} description={t('settings.teams.description')}>
      {error ? (
        <div className="mb-3 rounded-md border border-[var(--status-error)]/50 px-2 py-1.5 text-xs text-[var(--status-error)]">
          {error}
        </div>
      ) : null}
      <div className={SETTINGS_CARD_GRID_CLASS}>
        <SettingsAddCard
          label={t('settings.teams.add')}
          hint={t('settings.teams.addHint')}
          onClick={() => setEditing(blankPreset())}
        />
        {presets.map((preset) => (
          <SettingsCard
            key={preset.id}
            icon={<SettingsCardIcon name="team" />}
            title={preset.name}
            subtitle={preset.description ?? undefined}
            badges={(
              <>
                <SettingsCardChip>{t('settings.teams.memberCount', { count: preset.members.length })}</SettingsCardChip>
                {preset.builtIn ? <SettingsCardChip>{t('team.create.presets.builtIn')}</SettingsCardChip> : null}
              </>
            )}
            footer={(
              <span className="truncate text-muted-foreground">
                {preset.members.map((member) => member.name).join(' · ')}
              </span>
            )}
            onOpen={() => setEditing(preset)}
            actions={preset.builtIn ? undefined : [
              {
                label: t('settings.teams.delete.confirmAction'),
                icon: 'close',
                destructive: true,
                onSelect: () => setDeleting(preset),
              },
            ]}
            actionsLabel={t('settings.teams.actions')}
          />
        ))}
      </div>

      {editing ? (
        <PresetEditorDialog
          preset={editing}
          open
          onOpenChange={(next) => { if (!next) setEditing(null); }}
          onSaved={() => void reload()}
        />
      ) : null}

      <Dialog open={deleting !== null} onOpenChange={(next) => { if (!next) setDeleting(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.teams.delete.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.teams.delete.confirm', { name: deleting?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setDeleting(null)}>
              {t('team.create.cancel')}
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => void confirmDelete()}>
              {t('settings.teams.delete.confirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};
