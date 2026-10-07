import { create } from 'zustand';

/**
 * Which team a session belongs to, as the cheap answer for surfaces that
 * must not fetch: the team section already resolves the board once per
 * session and writes the answer here; a selection menu inside a message
 * reads it instead of fetching per mounted message.
 *
 * A stale entry is only as wrong as the last board snapshot: the section
 * clears or overwrites its own session key on every resolve, and a task
 * written against a dissolved team fails with the server's own 404 — no
 * silent success. Keys of other sessions are never touched.
 */
type TeamMembershipState = {
  sessionTeams: Record<string, string>;
  setSessionTeam: (sessionId: string, teamId: string | null) => void;
};

export const useTeamMembershipStore = create<TeamMembershipState>((set) => ({
  sessionTeams: {},
  setSessionTeam: (sessionId, teamId) => {
    set((state) => {
      const current = state.sessionTeams[sessionId] ?? null;
      const next = teamId ?? null;
      if (current === next) return state;
      const sessionTeams = { ...state.sessionTeams };
      if (next) sessionTeams[sessionId] = next;
      else delete sessionTeams[sessionId];
      return { sessionTeams };
    });
  },
}));
