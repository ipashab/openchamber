import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { TeamPullSummary, TeamTask } from '@/lib/team/team-board-api';

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

const { TeamTaskDetailsDialog } = await import('./TeamTaskDetailsDialog');

const fullTask: TeamTask = {
  taskId: 'task_full',
  subject: 'Compose the deployment checklist',
  description: 'Walk every step the release crew runs and write the checklist to doc/deploy.md.',
  status: 'in_progress',
  owner: 'member_alice',
  blockedBy: ['task_map', 'task_gone'],
  createdBy: 'lead',
  createdAt: 1760000000000,
  updatedAt: 1760000600000,
};

const bareTask: TeamTask = {
  taskId: 'task_bare',
  subject: 'Review the map',
  description: null,
  status: 'pending',
  owner: null,
  blockedBy: [],
  createdBy: null,
  createdAt: 1760000000000,
  updatedAt: 1760000000000,
};

const nameOf = (slotId: string) => ({ lead: 'Team Lead', member_alice: 'Alice' })[slotId] ?? slotId;
const subjectOf = (taskId: string) => ({ task_map: 'Map the modules' })[taskId] ?? taskId;

const markupFor = (task: TeamTask, pullSummary: TeamPullSummary | null = null): string => renderToStaticMarkup(
  <I18nProvider>
    <TeamTaskDetailsDialog
      open
      onOpenChange={() => undefined}
      task={task}
      teamId="team_1"
      nameOf={nameOf}
      subjectOf={subjectOf}
      pullSummary={pullSummary}
      pullLive={false}
    />
  </I18nProvider>,
);

describe('TeamTaskDetailsDialog', () => {
  test('carries the full brief and resolves roster and dependency names', () => {
    const markup = markupFor(fullTask);

    expect(markup).toContain('Compose the deployment checklist');
    expect(markup).toContain('Walk every step the release crew runs and write the checklist to doc/deploy.md.');
    expect(markup).toContain('In progress');
    expect(markup).toContain('Alice');
    expect(markup).toContain('Team Lead');
    // Зависимости показываются темами, а не внутренними id.
    expect(markup).toContain('Map the modules, task_gone');
    // Обе метки времени присутствуют — updatedAt отличается от createdAt.
    expect(markup).toContain('Created');
    expect(markup).toContain('Updated');
  });

  test('a bare task shows the no-brief placeholder and hides empty meta rows', () => {
    const markup = markupFor(bareTask);

    expect(markup).toContain('No brief — the subject is all the lead gave');
    expect(markup).toContain('Unassigned');
    expect(markup).not.toContain('Created by');
    expect(markup).not.toContain('Blocked by');
    expect(markup).not.toContain('Updated');
  });

  test('a task with a linked PR shows its live state beside the link affordance', () => {
    const withPull: TeamTask = {
      ...fullTask,
      pull: { owner: 'octo', repo: 'repo', number: 42, url: 'https://github.com/octo/repo/pull/42' },
    };
    const markup = markupFor(withPull, {
      owner: 'octo',
      repo: 'repo',
      number: 42,
      state: 'open',
      draft: false,
      title: 'Add the guard',
      mergeable: null,
      checks: { state: 'failure', total: 6 },
    });

    expect(markup).toContain('Pull request');
    expect(markup).toContain('PR #42 · open · CI failing');
    expect(markup).toContain('Open');
    expect(markup).toContain('Change');
  });

  test('a task without a PR offers to link one', () => {
    const markup = markupFor(bareTask);

    expect(markup).toContain('Not linked to a PR yet');
    expect(markup).toContain('Link a PR');
  });

  test('a completed task shows the attached result', () => {
    const doneTask: TeamTask = {
      ...fullTask,
      status: 'completed',
      result: 'Mapped 12 modules; doc/maps.md now lists each owner.',
    };
    const markup = markupFor(doneTask);

    expect(markup).toContain('Result');
    expect(markup).toContain('Mapped 12 modules; doc/maps.md now lists each owner.');
  });

  test('a completed task without a result says so; an unfinished task has no result row', () => {
    const doneBare: TeamTask = { ...bareTask, status: 'completed' };
    expect(markupFor(doneBare)).toContain('No result was attached when the task was completed');
    // The in_progress fixture carries a result the row must not show —
    // the section belongs to a finished task.
    const unfinishedWithStaleResult: TeamTask = { ...fullTask, result: 'stale answer' };
    expect(markupFor(unfinishedWithStaleResult)).not.toContain('Result');
    expect(markupFor(bareTask)).not.toContain('Result');
  });
});
