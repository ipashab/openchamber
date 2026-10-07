import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { formatDirectoryName } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { TEAM_MEMBER_COLOR_PALETTE } from '@/lib/team/teamMemberColors';
import { cn } from '@/lib/utils';
import {
  createAssistant,
  deleteAssistant,
  fetchAssistants,
  openAssistantChat,
  updateAssistant,
  type Assistant,
} from '@/lib/assistants/assistants-api';

// The address book's frames are its heartbeat: every write on the server —
// this tab or another — ends in one, and the page answers by refetching
// once per burst. Same cadence as the missions list.
const REFETCH_DEBOUNCE_MS = 400;

/**
 * A stable identity hue for a contact, same palette the team roster uses —
 * a contact and a teammate read as "someone" at a glance. The index is a
 * pure function of the id: no assignment bookkeeping, and the hue survives
 * every reload because the id does.
 */
const contactAccent = (assistantId: string): string =>
  TEAM_MEMBER_COLOR_PALETTE[
    Math.abs([...assistantId].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) | 0, 7))
    % TEAM_MEMBER_COLOR_PALETTE.length
  ];

const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('');
};

function AssistantsView({ onLeave }: { onLeave: () => void }) {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const setAssistantsDialogOpen = useUIStore((state) => state.setAssistantsDialogOpen);

  const [assistants, setAssistants] = React.useState<Assistant[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // The form covers both saving a new contact and editing the one it holds.
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [model, setModel] = React.useState('');
  const [agent, setAgent] = React.useState('');
  const [directory, setDirectory] = React.useState('');
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const reloadRef = React.useRef<(() => Promise<void>) | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const next = await fetchAssistants();
      setAssistants(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  reloadRef.current = reload;

  React.useEffect(() => {
    void reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void reloadRef.current?.();
      }, REFETCH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'assistant-changed') schedule();
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [reload]);

  // A brand-new contact drafts into whatever project the user is working in,
  // so saving from a project's chat files the contact where the work is.
  React.useEffect(() => {
    if (editingId) return;
    setDirectory((current) => current || activeProject?.path || '');
  }, [activeProject?.path, editingId]);

  const resetForm = React.useCallback(() => {
    setEditingId(null);
    setName('');
    setDescription('');
    setPrompt('');
    setModel('');
    setAgent('');
    setValidationError(null);
  }, []);

  const openCreateForm = React.useCallback(() => {
    resetForm();
    setDirectory(activeProject?.path || '');
    setFormOpen(true);
  }, [resetForm, activeProject?.path]);

  const openEditForm = React.useCallback((assistant: Assistant) => {
    setEditingId(assistant.id);
    setName(assistant.name);
    setDescription(assistant.description);
    setPrompt(assistant.prompt);
    setModel(assistant.model ?? '');
    setAgent(assistant.agent ?? '');
    setDirectory(assistant.directory);
    setValidationError(null);
    setFormOpen(true);
  }, []);

  const handleSubmit = React.useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName || !trimmedPrompt || !directory) {
      setValidationError(t('sessions.assistants.form.missingFields'));
      return;
    }
    setSubmitting(true);
    setValidationError(null);
    const draft = {
      name: trimmedName,
      description: description.trim(),
      prompt: trimmedPrompt,
      model: model.trim(),
      agent: agent.trim(),
      directory,
    };
    try {
      if (editingId) {
        await updateAssistant(editingId, draft);
        toast.success(t('sessions.assistants.toast.updated'));
      } else {
        await createAssistant(draft);
        toast.success(t('sessions.assistants.toast.created'));
      }
      resetForm();
      setFormOpen(false);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(editingId ? 'sessions.assistants.toast.updateFailed' : 'sessions.assistants.toast.createFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [name, description, prompt, model, agent, directory, editingId, resetForm, reload, t]);

  const openChat = React.useCallback(async (assistant: Assistant) => {
    setBusyId(assistant.id);
    try {
      const chat = await openAssistantChat(assistant.id, assistant.directory);
      useSessionUIStore.getState().setCurrentSession(chat.sessionId, chat.assistant.directory);
      setAssistantsDialogOpen(false);
      onLeave();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.assistants.toast.chatOpenFailed'));
    } finally {
      setBusyId(null);
    }
  }, [setAssistantsDialogOpen, onLeave, t]);

  const handleDelete = React.useCallback(async (assistant: Assistant) => {
    setBusyId(assistant.id);
    try {
      await deleteAssistant(assistant.id);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.assistants.toast.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  }, [reload, t]);

  const form = formOpen ? (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="typography-micro font-medium" htmlFor="assistant-name">{t('sessions.assistants.form.name.label')}</label>
          <Input
            id="assistant-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('sessions.assistants.form.name.placeholder')}
            maxLength={80}
          />
        </div>
        <div className="space-y-1.5">
          <label className="typography-micro font-medium" htmlFor="assistant-description">{t('sessions.assistants.form.description.label')}</label>
          <Input
            id="assistant-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('sessions.assistants.form.description.placeholder')}
            maxLength={500}
          />
        </div>
        <div className="space-y-1.5">
          <label className="typography-micro font-medium" htmlFor="assistant-prompt">{t('sessions.assistants.form.prompt.label')}</label>
          <Textarea
            id="assistant-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('sessions.assistants.form.prompt.placeholder')}
            rows={5}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="typography-micro font-medium" htmlFor="assistant-model">{t('sessions.assistants.form.model.label')}</label>
            <Input
              id="assistant-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={t('sessions.assistants.form.model.placeholder')}
              maxLength={120}
            />
          </div>
          <div className="space-y-1.5">
            <label className="typography-micro font-medium" htmlFor="assistant-agent">{t('sessions.assistants.form.agent.label')}</label>
            <Input
              id="assistant-agent"
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
              placeholder={t('sessions.assistants.form.agent.placeholder')}
              maxLength={120}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="typography-micro font-medium" htmlFor="assistant-directory">{t('sessions.assistants.form.project.label')}</label>
          <Select value={directory} onValueChange={setDirectory}>
            <SelectTrigger id="assistant-directory" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.path}>
                  {project.label?.trim() || formatDirectoryName(project.path, undefined)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {validationError ? (
          <p className="typography-micro" style={{ color: 'var(--status-error)' }}>{validationError}</p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => { resetForm(); setFormOpen(false); }}>
            {t('sessions.assistants.form.cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} disabled={submitting}>
            {t('sessions.assistants.form.submit')}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  const listBody = loading ? (
    <div className="flex items-center justify-center py-12 text-muted-foreground">
      <Icon name="loader" className="h-4 w-4 animate-spin" />
    </div>
  ) : loadError ? (
    <div className="mx-auto max-w-md rounded-md border p-3 typography-micro" style={{ borderColor: 'var(--status-error)', color: 'var(--status-error)' }}>
      {loadError}
    </div>
  ) : assistants.length === 0 ? (
    <div className="mx-auto max-w-md py-12 text-center">
      <p className="typography-meta font-medium">{t('sessions.assistants.empty.title')}</p>
      <p className="mt-1 typography-micro text-muted-foreground">{t('sessions.assistants.empty.body')}</p>
    </div>
  ) : (
    <div className="space-y-2">
      {assistants.map((assistant) => {
        const busy = busyId === assistant.id;
        return (
          <div key={assistant.id} className={cn('rounded-lg border border-border/70 bg-card p-4', busy && 'opacity-60')}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border typography-micro font-semibold"
                  style={{ borderColor: 'color-mix(in srgb, currentColor 35%, transparent)', color: contactAccent(assistant.id) }}
                >
                  {initialsOf(assistant.name)}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <p className="truncate typography-meta font-medium">{assistant.name}</p>
                    {assistant.lastSessionId ? (
                      <span className="inline-flex items-center gap-1 typography-micro text-muted-foreground">
                        <Icon name="chat-thread" className="h-3 w-3" />
                        {t('sessions.assistants.thread.started')}
                      </span>
                    ) : null}
                  </div>
                  {assistant.description ? (
                    <p className="truncate typography-micro text-muted-foreground/70">{assistant.description}</p>
                  ) : null}
                  <p className="typography-micro text-muted-foreground/70">{formatDirectoryName(assistant.directory, undefined)}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <Button size="sm" onClick={() => void openChat(assistant)} disabled={busy}>
                  <Icon name="chat-thread" className="h-4 w-4" /> {t('sessions.assistants.actions.open')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => openEditForm(assistant)}>
                  {t('sessions.assistants.actions.edit')}
                </Button>
                <Button variant="destructive" size="sm" aria-label={t('sessions.assistants.actions.delete')} onClick={() => void handleDelete(assistant)} disabled={busy}>
                  <Icon name="delete-bin" className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    // Full-page surface replacing the chat area (mounted inside <main>),
    // shaped like the Missions page: the app Header carries the title, the
    // page carries the address book. Pages have no close button: you leave
    // by opening a chat or another surface in the sidebar.
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex items-center justify-between px-6 pt-3">
        <p className="typography-meta text-muted-foreground">{t('sessions.assistants.description')}</p>
        <Button size="sm" onClick={openCreateForm} disabled={projects.length === 0}>
          <Icon name="add" className="h-4 w-4" /> {t('sessions.assistants.new.button')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {form}
          {listBody}
        </div>
      </div>
    </div>
  );
}

/** The desktop page, open while the UI store says so. */
export function AssistantsDialog() {
  const open = useUIStore((state) => state.isAssistantsDialogOpen);
  const setOpen = useUIStore((state) => state.setAssistantsDialogOpen);
  const leave = React.useCallback(() => setOpen(false), [setOpen]);
  return open ? <AssistantsView onLeave={leave} /> : null;
}
