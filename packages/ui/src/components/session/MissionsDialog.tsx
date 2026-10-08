import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { formatDirectoryName } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { cn } from '@/lib/utils';
import {
  cancelMission,
  createMission,
  deleteMission,
  fetchMissions,
  retryMission,
  MISSION_CONFIG_BOUNDS,
  updateMissionConfig,
  type Mission,
  type MissionConfig,
  type MissionMode,
  type MissionStatus,
} from '@/lib/missions/missions-api';

// The queue's frames are the list's heartbeat: every state move on the
// server ends in one, and the panel answers by refetching once per burst.
const REFETCH_DEBOUNCE_MS = 400;

const MISSION_MODES: MissionMode[] = ['session', 'team'];

const MODE_META = {
  session: {
    icon: 'chat-thread',
    labelKey: 'sessions.missions.form.mode.session',
    hintKey: 'sessions.missions.form.mode.session.hint',
  },
  team: {
    icon: 'team',
    labelKey: 'sessions.missions.form.mode.team',
    hintKey: 'sessions.missions.form.mode.team.hint',
  },
} as const satisfies Record<MissionMode, { icon: IconName; labelKey: string; hintKey: string }>;

const MODE_CHIP_KEY = {
  session: 'sessions.missions.mode.session',
  team: 'sessions.missions.mode.team',
} as const satisfies Record<MissionMode, string>;

const STATUS_META = {
  queued: { icon: 'time', color: 'var(--status-warning)', labelKey: 'sessions.missions.status.queued' },
  running: { icon: 'record-circle', color: 'var(--status-info)', labelKey: 'sessions.missions.status.running' },
  completed: { icon: 'checkbox-circle', color: 'var(--status-success)', labelKey: 'sessions.missions.status.completed' },
  failed: { icon: 'close-circle', color: 'var(--status-error)', labelKey: 'sessions.missions.status.failed' },
  cancelled: { icon: 'close', color: 'text-muted-foreground', labelKey: 'sessions.missions.status.cancelled' },
} as const satisfies Record<MissionStatus, { icon: IconName; color: string; labelKey: string }>;

function MissionsView({ onLeave }: { onLeave: () => void }) {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const setMissionsDialogOpen = useUIStore((state) => state.setMissionsDialogOpen);

  const [missions, setMissions] = React.useState<Mission[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  // The queue's settings card: drafts are strings so the typing experience
  // is the input's own, converted at save time with the bounds checked here
  // and again on the server.
  const [config, setConfig] = React.useState<MissionConfig | null>(null);
  const [configOpen, setConfigOpen] = React.useState(false);
  const [concurrencyDraft, setConcurrencyDraft] = React.useState('2');
  const [windowDraft, setWindowDraft] = React.useState('60');
  const [configError, setConfigError] = React.useState<string | null>(null);
  const [savingConfig, setSavingConfig] = React.useState(false);

  // The new-goal draft. The mode defaults to a lone session — a team is a
  // deliberate upgrade the user opts into per goal.
  const [title, setTitle] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [mode, setMode] = React.useState<MissionMode>('session');
  const [directory, setDirectory] = React.useState('');
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const reloadRef = React.useRef<(() => Promise<void>) | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const next = await fetchMissions();
      setMissions(next.missions);
      setConfig(next.config);
      // Drafts follow the server's config only while the card is closed;
      // an open card is the user's edit, not the server's echo.
      if (!configOpenRef.current) {
        setConcurrencyDraft(String(next.config.maxConcurrent));
        setWindowDraft(String(Math.round(next.config.maxRunMs / 60_000)));
      }
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const configOpenRef = React.useRef(false);
  React.useEffect(() => {
    configOpenRef.current = configOpen;
  }, [configOpen]);

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
      if (event.type === 'mission-changed') schedule();
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [reload]);

  // The directory draft follows whatever project the user is working in, so
  // a goal filed from a project's chat lands in that project by default.
  React.useEffect(() => {
    setDirectory((current) => current || activeProject?.path || '');
  }, [activeProject?.path]);

  const resetForm = React.useCallback(() => {
    setTitle('');
    setPrompt('');
    setMode('session');
    setValidationError(null);
  }, []);

  const handleSubmit = React.useCallback(async () => {
    const trimmedTitle = title.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedTitle || !trimmedPrompt || !directory) {
      setValidationError(t('sessions.missions.form.missingFields'));
      return;
    }
    setSubmitting(true);
    setValidationError(null);
    try {
      await createMission({ title: trimmedTitle, prompt: trimmedPrompt, mode, directory });
      toast.success(t('sessions.missions.toast.created'));
      resetForm();
      setFormOpen(false);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.missions.toast.createFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [title, prompt, directory, mode, resetForm, reload, t]);

  const openSession = React.useCallback((mission: Mission) => {
    useSessionUIStore.getState().setCurrentSession(mission.sessionId, mission.directory);
    setMissionsDialogOpen(false);
    onLeave();
  }, [setMissionsDialogOpen, onLeave]);

  const handleCancel = React.useCallback(async (mission: Mission) => {
    setBusyId(mission.missionId);
    try {
      await cancelMission(mission.missionId);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.missions.toast.cancelFailed'));
    } finally {
      setBusyId(null);
    }
  }, [reload, t]);

  const handleRetry = React.useCallback(async (mission: Mission) => {
    setBusyId(mission.missionId);
    try {
      await retryMission(mission.missionId);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.missions.toast.retryFailed'));
    } finally {
      setBusyId(null);
    }
  }, [reload, t]);

  const handleDelete = React.useCallback(async (mission: Mission) => {
    setBusyId(mission.missionId);
    try {
      await deleteMission(mission.missionId);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.missions.toast.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  }, [reload, t]);

  const handleSaveConfig = React.useCallback(async () => {
    const concurrency = Number.parseInt(concurrencyDraft, 10);
    const minutes = Number.parseInt(windowDraft, 10);
    const { maxConcurrent, windowMinutes } = MISSION_CONFIG_BOUNDS;
    if (!Number.isInteger(concurrency) || concurrency < maxConcurrent.min || concurrency > maxConcurrent.max) {
      setConfigError(t('sessions.missions.settings.concurrency.invalid'));
      return;
    }
    if (!Number.isInteger(minutes) || minutes < windowMinutes.min || minutes > windowMinutes.max) {
      setConfigError(t('sessions.missions.settings.window.invalid'));
      return;
    }
    setSavingConfig(true);
    setConfigError(null);
    try {
      const saved = await updateMissionConfig({
        maxConcurrent: concurrency,
        maxRunMs: minutes * 60_000,
      });
      setConfig(saved);
      toast.success(t('sessions.missions.toast.configSaved'));
      setConfigOpen(false);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.missions.toast.configFailed'));
    } finally {
      setSavingConfig(false);
    }
  }, [concurrencyDraft, windowDraft, reload, t]);

  const form = formOpen ? (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="typography-micro font-medium" htmlFor="mission-title">{t('sessions.missions.form.title.label')}</label>
          <Input
            id="mission-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('sessions.missions.form.title.placeholder')}
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5">
          <label className="typography-micro font-medium" htmlFor="mission-prompt">{t('sessions.missions.form.prompt.label')}</label>
          <Textarea
            id="mission-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('sessions.missions.form.prompt.placeholder')}
            rows={5}
          />
        </div>
        <div className="space-y-1.5">
          <span className="typography-micro font-medium">{t('sessions.missions.form.mode.label')}</span>
          <div className="grid grid-cols-2 gap-2">
            {MISSION_MODES.map((candidate) => {
              const meta = MODE_META[candidate];
              const selected = mode === candidate;
              return (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setMode(candidate)}
                  aria-pressed={selected}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors',
                    selected ? 'border-primary/70 bg-primary/5' : 'border-border/70 hover:bg-muted/50',
                  )}
                >
                  <span className="flex items-center gap-1.5 typography-micro font-medium">
                    <Icon name={meta.icon} className="h-3.5 w-3.5" />
                    {t(meta.labelKey)}
                  </span>
                  <span className="typography-micro text-muted-foreground">{t(meta.hintKey)}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="typography-micro font-medium" htmlFor="mission-directory">{t('sessions.missions.form.project.label')}</label>
          <Select value={directory} onValueChange={setDirectory}>
            <SelectTrigger id="mission-directory" size="sm">
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
            {t('sessions.missions.form.cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} disabled={submitting}>
            {t('sessions.missions.form.submit')}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  const configCard = configOpen ? (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="typography-micro font-medium" htmlFor="mission-concurrency">
            {t('sessions.missions.settings.concurrency.label')}
          </label>
          <Input
            id="mission-concurrency"
            type="number"
            inputMode="numeric"
            min={MISSION_CONFIG_BOUNDS.maxConcurrent.min}
            max={MISSION_CONFIG_BOUNDS.maxConcurrent.max}
            step={1}
            value={concurrencyDraft}
            onChange={(event) => setConcurrencyDraft(event.target.value)}
          />
          <p className="typography-micro text-muted-foreground">{t('sessions.missions.settings.concurrency.hint')}</p>
        </div>
        <div className="space-y-1.5">
          <label className="typography-micro font-medium" htmlFor="mission-window">
            {t('sessions.missions.settings.window.label')}
          </label>
          <Input
            id="mission-window"
            type="number"
            inputMode="numeric"
            min={MISSION_CONFIG_BOUNDS.windowMinutes.min}
            max={MISSION_CONFIG_BOUNDS.windowMinutes.max}
            step={1}
            value={windowDraft}
            onChange={(event) => setWindowDraft(event.target.value)}
          />
          <p className="typography-micro text-muted-foreground">{t('sessions.missions.settings.window.hint')}</p>
        </div>
        {configError ? (
          <p className="typography-micro" style={{ color: 'var(--status-error)' }}>{configError}</p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setConfigOpen(false)}>
            {t('sessions.missions.form.cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleSaveConfig()} disabled={savingConfig || config === null}>
            {t('sessions.missions.settings.save')}
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
  ) : missions.length === 0 ? (
    <div className="mx-auto max-w-md py-12 text-center">
      <p className="typography-meta font-medium">{t('sessions.missions.empty.title')}</p>
      <p className="mt-1 typography-micro text-muted-foreground">{t('sessions.missions.empty.body')}</p>
    </div>
  ) : (
    <div className="space-y-2">
      {missions.map((mission) => {
        const statusMeta = STATUS_META[mission.status];
        const busy = busyId === mission.missionId;
        return (
          <div key={mission.missionId} className={cn('rounded-lg border border-border/70 bg-card p-4', busy && 'opacity-60')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 typography-micro font-medium" style={{ color: statusMeta.color }}>
                    <Icon name={statusMeta.icon} className="h-3.5 w-3.5" />
                    {t(statusMeta.labelKey)}
                  </span>
                  <span className="typography-micro text-muted-foreground">{t(MODE_CHIP_KEY[mission.mode])}</span>
                </div>
                <p className="mt-1 truncate typography-meta font-medium">{mission.title}</p>
                <p className="typography-micro text-muted-foreground/70">{formatDirectoryName(mission.directory, undefined)}</p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {mission.sessionId ? (
                  <Button variant="outline" size="sm" aria-label={t('sessions.missions.actions.openSession')} onClick={() => openSession(mission)}>
                    <Icon name="external-link" className="h-4 w-4" />
                  </Button>
                ) : null}
                {mission.status === 'queued' || mission.status === 'running' ? (
                  <Button variant="outline" size="sm" onClick={() => void handleCancel(mission)} disabled={busy}>
                    {t('sessions.missions.actions.cancel')}
                  </Button>
                ) : null}
                {mission.status === 'completed' || mission.status === 'failed' || mission.status === 'cancelled' ? (
                  <Button variant="outline" size="sm" onClick={() => void handleRetry(mission)} disabled={busy}>
                    {t('sessions.missions.actions.retry')}
                  </Button>
                ) : null}
                <Button variant="destructive" size="sm" aria-label={t('sessions.missions.actions.delete')} onClick={() => void handleDelete(mission)} disabled={busy}>
                  <Icon name="delete-bin" className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {mission.error ? (
              <div
                className="mt-3 flex items-start gap-2 rounded-md border p-2 typography-micro"
                style={{ borderColor: 'var(--status-error)', color: 'var(--status-error)' }}
              >
                <Icon name="error-warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">{mission.error}</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  return (
    // Full-page surface replacing the chat area (mounted inside <main>),
    // shaped like the Scheduled page: the app Header carries the title, the
    // page carries the list. Pages have no close button: you leave by
    // picking a session or another surface in the sidebar.
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex items-center justify-between px-6 pt-3">
        <p className="typography-meta text-muted-foreground">{t('sessions.missions.description')}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label={t('sessions.missions.settings.open')}
            aria-pressed={configOpen}
            onClick={() => setConfigOpen((open) => !open)}
          >
            <Icon name="settings-3" className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => setFormOpen((open) => !open)} disabled={projects.length === 0}>
            <Icon name="add" className="h-4 w-4" /> {t('sessions.missions.new.button')}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {configCard}
          {form}
          {listBody}
        </div>
      </div>
    </div>
  );
}

/** The desktop page, open while the UI store says so. */
export function MissionsDialog() {
  const open = useUIStore((state) => state.isMissionsDialogOpen);
  const setOpen = useUIStore((state) => state.setMissionsDialogOpen);
  const leave = React.useCallback(() => setOpen(false), [setOpen]);
  return open ? <MissionsView onLeave={leave} /> : null;
}
