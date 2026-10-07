import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { TeamBoard } from '@/lib/team/team-board-api';

// The heavy dialog chrome and the roster cards are not what this file checks;
// the recipe block and its calls are.
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

mock.module('@/components/session/team/TeamMemberEditor', () => ({
  TeamMemberEditor: () => <div data-testid="member-editor" />,
}));

mock.module('@/components/session/team/useTeamEditorOptions', () => ({
  useTeamEditorOptions: () => ({
    agentOptions: [],
    modelOptions: [],
    skillOptions: [],
    mcpOptions: [],
    ensureLoaded: () => undefined,
  }),
}));

mock.module('@/lib/team/teamAskLead', () => ({
  askLeadToStaff: mock(() => undefined),
}));

const { TeamEditDialog } = await import('./TeamEditDialog');

const board: TeamBoard = {
  id: 'team_1',
  name: 'Crew',
  directory: '/work/project',
  createdAt: 1760000000000,
  members: [
    { slotId: 'lead', name: 'Team Lead', role: 'lead', status: 'idle', sessionId: 'ses_lead', unreadCount: 0 },
  ],
  tasks: [],
  recentMessages: [],
};

const markupWith = (seams: Partial<React.ComponentProps<typeof TeamEditDialog>> = {}): string => renderToStaticMarkup(
  <I18nProvider>
    <TeamEditDialog
      open
      onOpenChange={() => undefined}
      board={board}
      directory="/work/project"
      exportPreset={seams.exportPreset ?? (async () => null as never)}
      savePreset={seams.savePreset ?? (async () => null as never)}
    />
  </I18nProvider>,
) as never;

describe('TeamEditDialog recipe block', () => {
  test('offers saving the roster as a preset and downloading the JSON recipe', () => {
    const markup = markupWith();

    expect(markup).toContain('Team recipe');
    expect(markup).toContain('Save as preset');
    expect(markup).toContain('Download JSON');
    // Пока экспорт не прошёл — подписи об успехе нет.
    expect(markup).not.toContain('Saved as a new preset');
  });

  test('renders the roster rows and keeps the add path intact', () => {
    const markup = markupWith();

    expect(markup).toContain('Team Lead');
    expect(markup).toContain('Add to team');
    // Подсказка-заместитель: состав умеет подбирать и сам лид.
    expect(markup).toContain('Ask the Team Lead to pick someone');
  });
});
