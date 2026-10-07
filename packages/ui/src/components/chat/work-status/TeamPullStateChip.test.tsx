import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { TeamPullSummary } from '@/lib/team/team-board-api';

import { TeamPullStateChip } from './TeamPullStateChip';

const pull = { owner: 'octo', repo: 'repo', number: 42, url: 'https://github.com/octo/repo/pull/42' };

const summaryWith = (overrides: Partial<TeamPullSummary>): TeamPullSummary => ({
  owner: 'octo',
  repo: 'repo',
  number: 42,
  state: 'open',
  draft: false,
  title: 'Add the guard',
  mergeable: null,
  ...overrides,
});

const markupFor = (summary: TeamPullSummary | null, live: 'ok' | 'disconnected' | 'unavailable' | false = 'ok'): string => renderToStaticMarkup(
  <I18nProvider>
    <TeamPullStateChip pull={pull} summary={summary} live={live} />
  </I18nProvider>,
);

describe('TeamPullStateChip', () => {
  test('shows the PR number and CI verdict while the PR is live', () => {
    const failing = markupFor(summaryWith({ checks: { state: 'failure', total: 6 } }));
    expect(failing).toContain('PR #42');
    expect(failing).toContain('CI failing');
    expect(failing).toContain('var(--status-error)');

    const passing = markupFor(summaryWith({ checks: { state: 'success', total: 6 } }));
    expect(passing).toContain('CI passing');
    expect(passing).toContain('var(--status-success)');

    const running = markupFor(summaryWith({ checks: { state: 'pending', total: 3 } }));
    expect(running).toContain('CI running');
    expect(running).toContain('var(--status-warning)');
  });

  test('names the PR state when there are no checks to count', () => {
    expect(markupFor(summaryWith({ draft: true }))).toContain('draft');
    expect(markupFor(summaryWith({ draft: true }))).toContain('var(--status-info)');
    expect(markupFor(summaryWith({ state: 'merged', checks: null }))).toContain('merged');
    expect(markupFor(summaryWith({ state: 'closed', checks: null }))).toContain('closed');
  });

  test('says unknown before the first answer and when the PR cannot be resolved', () => {
    expect(markupFor(null, false)).toContain('PR #42');
    expect(markupFor(null, false)).not.toContain('unknown');
    expect(markupFor(null, 'ok')).toContain('PR #42 · unknown');
    expect(markupFor(null, 'unavailable')).toContain('PR #42 · unknown');
  });

  test('carries the PR title and URL in the tooltip', () => {
    expect(markupFor(summaryWith({}))).toContain('Add the guard');
    expect(markupFor(summaryWith({}))).toContain('https://github.com/octo/repo/pull/42');
  });
});
