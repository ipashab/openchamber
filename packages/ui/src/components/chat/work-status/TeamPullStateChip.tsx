import React from 'react';

import { useI18n } from '@/lib/i18n';
import type { TeamPullSummary, TeamTask } from '@/lib/team/team-board-api';

type Props = {
  pull: NonNullable<TeamTask['pull']>;
  /** null means the PR could not be resolved — unknown, not closed. */
  summary: TeamPullSummary | null;
  /** false before the first answer; then the server's own status word. */
  live: 'ok' | 'disconnected' | 'unavailable' | false;
};

/**
 * The PR state of a task, as the board reads it. One token, two clauses:
 * the PR number and — once the live state is in — CI, drawn from status
 * tokens. The details dialog keeps the clickable link and the breakdown;
 * on a card this is the at-a-glance answer to "is this in review".
 */
export const TeamPullStateChip: React.FC<Props> = ({ pull, summary, live }) => {
  const { t } = useI18n();

  const checks = summary?.checks ?? null;
  const color = (() => {
    if (!summary) return 'var(--muted-foreground)';
    if (summary.state === 'merged') return 'var(--status-success)';
    if (summary.state === 'closed') return 'var(--muted-foreground)';
    if (checks?.state === 'failure') return 'var(--status-error)';
    if (checks?.state === 'pending') return 'var(--status-warning)';
    if (checks?.state === 'success') return 'var(--status-success)';
    return 'var(--status-info)';
  })();

  const label = (() => {
    const number = `PR #${pull.number}`;
    if (!summary) return live === false ? number : t('chat.workStatus.teamBoard.pull.unknown', { number });
    const state = summary.state === 'merged'
      ? t('chat.workStatus.teamBoard.pull.merged')
      : summary.state === 'closed'
        ? t('chat.workStatus.teamBoard.pull.closed')
        : summary.draft
          ? t('chat.workStatus.teamBoard.pull.draft')
          : t('chat.workStatus.teamBoard.pull.open');
    const ci = checks && checks.total > 0
      ? ` · ${checks.state === 'failure'
        ? t('chat.workStatus.teamBoard.pull.ciFailing')
        : checks.state === 'pending'
          ? t('chat.workStatus.teamBoard.pull.ciPending')
          : t('chat.workStatus.teamBoard.pull.ciPassing')}`
      : '';
    return `${number} · ${state}${ci}`;
  })();

  const title = [summary?.title, pull.url].filter(Boolean).join('\n');

  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded-full px-1.5 text-[10px] font-medium leading-4"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}
      title={title || undefined}
    >
      {label}
    </span>
  );
};
