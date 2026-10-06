import { useEffect, useMemo, useRef, useState } from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { fetchTeamBoards, type TeamBoard } from '@/lib/team/team-board-api';

const REFETCH_DEBOUNCE_MS = 250;

/**
 * The team board of the session this renders for: the lead's panel and every
 * teammate's panel show the same roster, mailbox and board.
 *
 * The board is fetched whole and refetched whenever the server says any team
 * moved — the events name the team but not the change, and a diffed update
 * could not be smaller than the fetch it saves. Team state is capped on the
 * server (300 messages, 500 tasks, content clipped to 400 chars), so one
 * response stays a small payload. A failed fetch leaves the last good board
 * in place: an unreachable server is silence, not an empty team.
 */
export const useTeamBoard = (
  sessionId: string | null,
  options: { fetchTeamBoards?: typeof fetchTeamBoards } = {},
): { board: TeamBoard | null; loading: boolean } => {
  const [boards, setBoards] = useState<TeamBoard[] | null>(null);
  // The seam keeps the effect's dependency list stable; swapping the fetcher
  // per render would refire the load on every parent render.
  const fetcherRef = useRef<typeof fetchTeamBoards>(options.fetchTeamBoards ?? fetchTeamBoards);
  fetcherRef.current = options.fetchTeamBoards ?? fetchTeamBoards;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const teams = await fetcherRef.current();
        if (!cancelled) setBoards(teams);
      } catch {
        // The panel renders nothing until a fetch succeeds; a later event
        // retries.
      }
    };
    void load();
    // A spawn or a wave of task updates bursts many frames at once; each one
    // only needs to schedule the one fetch that covers them all.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, REFETCH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'team-changed') schedule();
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const board = useMemo(
    () => (sessionId && boards ? boards.find((team) => team.members.some((member) => member.sessionId === sessionId)) ?? null : null),
    [boards, sessionId],
  );
  return { board, loading: boards === null };
};
