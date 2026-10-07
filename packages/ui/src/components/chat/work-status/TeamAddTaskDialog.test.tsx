import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { TeamBoard } from '@/lib/team/team-board-api';

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

mock.module('@/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => <div data-value={value}>{children}</div>,
  SelectTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SelectValue: ({ children }: React.PropsWithChildren) => (
    <>{children}</>
  ),
}));

const { TeamAddTaskDialog } = await import('./TeamAddTaskDialog');

// The board the roster picker reads: a lead and two teammates, the shape the
// panel passes after a live fetch.
const board: TeamBoard = {
  id: 'team_1',
  name: 'Crew',
  directory: '/work/project',
  createdAt: 1760000000000,
  members: [
    { slotId: 'lead', name: 'Team Lead', role: 'lead', status: 'idle', domain: null, isDomainLead: false, sessionId: 'ses_lead', unreadCount: 0 },
    { slotId: 'member_alice', name: 'Alice', role: 'teammate', status: 'idle', domain: null, isDomainLead: false, sessionId: 'ses_alice', unreadCount: 0 },
    { slotId: 'member_bob', name: 'Bob', role: 'teammate', status: 'busy', domain: null, isDomainLead: false, sessionId: 'ses_bob', unreadCount: 2 },
  ],
  tasks: [],
  recentMessages: [],
};

const markupFor = (renderBoard: TeamBoard = board): string => renderToStaticMarkup(
  <I18nProvider>
    <TeamAddTaskDialog open onOpenChange={() => undefined} board={renderBoard} />
  </I18nProvider>,
);

describe('TeamAddTaskDialog', () => {
  test('renders the subject, brief and a teammate-only owner picker', () => {
    const markup = markupFor();

    expect(markup).toContain('Add a task');
    expect(markup).toContain('What needs to be done?');
    expect(markup).toContain('Optional context for whoever picks it up');
    // The owner picker lists teammates only — the lead coordinates the board
    // and never owns a task.
    expect(markup).toContain('Alice');
    expect(markup).toContain('Bob');
    expect(markup).not.toContain('data-value="lead"');
    expect(markup).toContain('Unassigned');
    expect(markup).toContain('Add task');
    expect(markup).toContain('Cancel');
  });

  test('hides the owner picker when the roster has no teammates', () => {
    const solo: TeamBoard = {
      ...board,
      members: [board.members[0]],
    };
    const markup = markupFor(solo);

    expect(markup).not.toContain('Assign to');
    expect(markup).toContain('Add a task');
  });
});
