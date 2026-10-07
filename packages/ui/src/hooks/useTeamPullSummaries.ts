import { useEffect, useRef, useState } from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { fetchTeamPullSummaries, type TeamPullSummary } from '@/lib/team/team-board-api';

const REFETCH_DEBOUNCE_MS = 250;

/** The summary map, keyed by task id; a null value means the PR could not be resolved. */
type TeamPullSummaryMap = Record<string, TeamPullSummary | null>;

type PullSummariesState = {
  summaries: TeamPullSummaryMap | null;
  /** false before the first answer lands; then the server's own status word. */
  live: false | 'ok' | 'disconnected' | 'unavailable';
};

/**
 * The live GitHub state of the board's PR-linked tasks: the chips on the
 * cards and the PR row in the details dialog.
 *
 * Refetches ride the same team-changed signal the board does, but only while
 * the board actually carries PR links — a team without reviewable work never
 * talks to GitHub. The server caches each pull for its TTL window, so the
 * burst of events a busy team produces costs the cache, not the provider.
 * Disconnected and rate-limited answers are kept as the status they name:
 * the chips render as unknown, and the next event retries. A failed fetch is
 * silence, not a cleared board decoration.
 */
export const useTeamPullSummaries = (
  teamId: string,
  hasPulls: boolean,
  options: { fetchSummaries?: typeof fetchTeamPullSummaries } = {},
): PullSummariesState => {
  const [state, setState] = useState<PullSummariesState>({ summaries: null, live: false });
  // The seam keeps the effect's dependency list stable; swapping the fetcher
  // per render would refire the load on every parent render.
  const fetcherRef = useRef<typeof fetchTeamPullSummaries>(options.fetchSummaries ?? fetchTeamPullSummaries);
  fetcherRef.current = options.fetchSummaries ?? fetchTeamPullSummaries;

  useEffect(() => {
    if (!hasPulls || !teamId) {
      setState({ summaries: null, live: false });
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetcherRef.current(teamId);
        if (!cancelled) {
          setState(result.status === 'ok'
            ? { summaries: result.summaries, live: 'ok' }
            : { summaries: null, live: result.status });
        }
      } catch {
        // The chips fall back to the plain link; a later event retries.
      }
    };
    void load();
    // A team turn bursts many frames at once; each one only needs to schedule
    // the one fetch that covers them all.
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
  }, [teamId, hasPulls]);

  return state;
};
