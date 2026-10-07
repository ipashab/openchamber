// «Попроси лида» — путь, которым состав команды меняется чаще всего: у лида
// есть вся команда на руках и инструменты подбора. Открывает чат лида — ту
// же маршрутизацию, что и строки ростера (desktop: pinned-вкладка,
// mobile/VS Code: смена основной сессии) — и адресует заготовку черновика
// именно тому композеру, где этот чат окажется.

import { isVSCodeRuntime } from '@/lib/desktop';
import type { TeamMember } from '@/lib/team/team-board-api';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Puts a prefilled draft into the lead's composer and brings that chat into
 * view. The draft is translated by the caller: this module navigates, it does
 * not own copy. Sending stays the user's act — the draft lands in the box,
 * not in the wire.
 */
export const askLeadToStaff = (lead: TeamMember, draft: string, directory: string | null): void => {
  if (!directory) return;
  const leadSessionId = lead.sessionId;
  const { isMobile, openContextPanelTab } = useUIStore.getState();

  if (isMobile || isVSCodeRuntime()) {
    useSessionUIStore.getState().setCurrentSession(leadSessionId, directory);
    // The lead becomes the main chat: its composer consumes a null-target draft.
    useInputStore.getState().setPendingInputText(draft, 'replace', null);
    return;
  }

  if (useSessionUIStore.getState().currentSessionId !== leadSessionId) {
    openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: `session:${leadSessionId}`,
      label: lead.name,
      // Writable on purpose: this is the one chat where the user speaks
      // rather than watches.
    });
    // A pinned chat tab owns its own composer, targeted by its session id.
    useInputStore.getState().setPendingInputText(draft, 'replace', leadSessionId);
    return;
  }

  // Already talking with the lead in the main column: prefill it directly.
  useInputStore.getState().setPendingInputText(draft, 'replace', null);
};
