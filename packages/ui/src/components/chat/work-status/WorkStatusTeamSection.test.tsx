import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import type { TeamBoard } from '@/lib/team/team-board-api';

let WorkStatusTeamSection: typeof import('./WorkStatusTeamSection').WorkStatusTeamSection;

const directory = '/team-test';

const board: TeamBoard = {
  id: 'team_1',
  name: 'Crew',
  directory,
  createdAt: 1,
  members: [
    { slotId: 'lead', name: 'Team Lead', role: 'lead', status: 'idle', sessionId: 'ses_lead', unreadCount: 1 },
    { slotId: 'member_alice', name: 'Alice', role: 'teammate', status: 'busy', sessionId: 'ses_alice', unreadCount: 2 },
    { slotId: 'member_bob', name: 'Bob', role: 'teammate', status: 'failed', sessionId: 'ses_bob', unreadCount: 0 },
  ],
  tasks: [
    { taskId: 'task_1', subject: 'Map the modules', description: 'Walk the lib directory and map the modules.', status: 'in_progress', owner: 'member_alice', blockedBy: [], createdBy: 'lead', createdAt: 1, updatedAt: 2 },
    { taskId: 'task_2', subject: 'Review the map', description: null, status: 'pending', owner: 'member_ghost', blockedBy: ['task_1'], createdBy: 'lead', createdAt: 3, updatedAt: 3 },
  ],
  recentMessages: [],
};

describe('team section rows', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;

  const render = async (sessionId: string | null) => {
    const sdk = OpenCode.make({ baseUrl: 'http://team.test', fetch: () => new Promise<Response>(() => undefined) });
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider>
          <WorkStatusTeamSection sessionId={sessionId} directory={directory} fetchTeamBoards={async () => [board]} />
        </I18nProvider>
      </SyncProvider>,
    ));
  };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLIFrameElement: win.HTMLIFrameElement, localStorage: win.localStorage,
      getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    ({ WorkStatusTeamSection } = await import('./WorkStatusTeamSection'));
    useUIStore.setState({ workStatusExpandedSections: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await win.happyDOM.close();
    restoreGlobals();
    container.remove();
  });

  test('shows the roster with live status and the task board for a member session', async () => {
    await render('ses_lead');

    const section = container.querySelector('[data-work-status-section="team"]');
    expect(section).not.toBeNull();

    // The row button is stretched under its content, so its text lives in the
    // row element around it.
    const rowText = (label: string) => {
      const button = container.querySelector(`button[aria-label*="${label}"]`);
      return button?.parentElement?.textContent ?? '';
    };

    expect(rowText('Open Alice')).toContain('working');
    expect(rowText('Open Alice')).toContain('2 unread');

    expect(section?.textContent).toContain('Task board');
    expect(section?.textContent).toContain('Map the modules');
    expect(section?.textContent).toContain('blocked');

    // Failed members stay visible with their failure, not filtered to a green board.
    expect(rowText('Open Bob')).toContain('failed');
  });

  test('renders nothing for a session outside every team', async () => {
    await render('ses_outsider');
    expect(container.querySelector('[data-work-status-section="team"]')).toBeNull();
  });

  test('a teammate session gets the same board as the lead', async () => {
    await render('ses_alice');
    const section = container.querySelector('[data-work-status-section="team"]');
    expect(section?.textContent).toContain('Team Lead');
    expect(section?.textContent).toContain('Task board');
  });
});
