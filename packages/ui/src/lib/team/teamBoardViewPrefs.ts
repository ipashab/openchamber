// The per-team choice between the two faces of a team tab in the context
// panel: the task board or the parallel chat columns. Stored per team so two
// teams remember their own open view, the same display-only, best-effort
// contract as the board's grouping choice.

import { z } from 'zod';

export type TeamBoardViewMode = 'board' | 'chats' | 'activity';

const DEFAULT_VIEW: TeamBoardViewMode = 'board';

const storageSchema = z.record(z.string(), z.enum(['board', 'chats', 'activity']));

const STORAGE_KEY = 'oc.teamBoard.view.v1';

/** The stored view for this team; anything unreadable opens on the board. */
export const readTeamBoardView = (teamId: string): TeamBoardViewMode => {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEW;
    const parsed = storageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data[teamId] ?? DEFAULT_VIEW : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
};

/** Persist this team's view beside the others, best-effort display preference. */
export const writeTeamBoardView = (teamId: string, view: TeamBoardViewMode): void => {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    const parsed = raw === null ? null : storageSchema.safeParse(JSON.parse(raw));
    const stored = parsed?.success ? parsed.data : {};
    stored[teamId] = view;
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The mounted tab keeps the chosen view for this open.
  }
};
