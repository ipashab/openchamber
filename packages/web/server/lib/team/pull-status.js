/**
 * The board's pull-request summaries: the live GitHub state of every task
 * carrying a PR link, keyed by task id for the panel.
 *
 * The board refetches on every team event, and a busy team moves several
 * times a minute — but a PR's state does not. Answers are cached per
 * pull for the TTL window, so the refetch that follows a mailbox message
 * costs the cache, not GitHub. The module owns no route; `routes.js`
 * registers it with the same lazy GitHub loaders the tracked-items
 * readers use, because the account, token and rate-limit state live in
 * the GitHub module, not here.
 */

import { z } from 'zod';

const SUMMARY_TTL_MS = 60_000;

const now = () => Date.now();

/**
 * The pull-valid shape the route will send to GitHub: whatever the service
 * wrote. Serialized state edited by hand or a value from an older shape does
 * not reach the API — it is parsed here, at the boundary, and a value that
 * does not parse is skipped, not guessed at.
 */
const pullRefSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string(),
});

const parsedPullRef = (pull) => {
  const result = pullRefSchema.safeParse(pull);
  return result.success ? result.data : null;
};

const createTeamPullStatus = ({
  loadGitHub = () => import('../github/index.js'),
  loadGitHubSummaries = () => import('../github/pr-summaries.js'),
  loadGitHubRateLimit = () => import('../github/rate-limit.js'),
} = {}) => {
  // Per-instance: summaries live exactly as long as the wired route does.
  const cache = new Map();
  const cacheKeyOf = (pull) => `${pull.owner}/${pull.repo}#${pull.number}`;
  return {
  /**
   * Live summaries for the team's tasks. `status` follows the tracked-items
   * contract: 'ok' with a per-task map, or 'disconnected' / 'unavailable'
   * with no map — the panel renders the chip as unknown rather than failing
   * the board it decorates. Tasks without a PR are absent from the map.
   */
  read: async (tasks) => {
    const refsByTask = new Map();
    for (const task of tasks ?? []) {
      const ref = parsedPullRef(task?.pull);
      if (!ref) continue;
      refsByTask.set(task.taskId, ref);
    }
    if (refsByTask.size === 0) return { status: 'ok', summaries: {} };

    const [github, summariesModule, rateLimit] = await Promise.all([
      loadGitHub(),
      loadGitHubSummaries(),
      loadGitHubRateLimit(),
    ]);
    if (rateLimit.isGitHubRateLimited()) return { status: 'unavailable' };
    const octokit = await github.getOctokitOrNull();
    if (!octokit) return { status: 'disconnected' };

    const fresh = new Map();
    const freshAt = now();
    const stale = [];
    for (const [taskId, pull] of refsByTask) {
      const key = cacheKeyOf(pull);
      const hit = cache.get(key);
      if (hit && freshAt - hit.at < SUMMARY_TTL_MS) {
        fresh.set(taskId, hit.summary);
      } else {
        stale.push({ taskId, pull, key });
      }
    }
    if (stale.length > 0) {
      try {
        const { summaries } = await summariesModule.fetchPrSummaries({
          octokit,
          refs: stale.map(({ pull }) => ({ owner: pull.owner, repo: pull.repo, number: pull.number })),
        });
        const byRef = new Map(summaries.map((summary) => [cacheKeyOf(summary), summary]));
        for (const { taskId, pull, key } of stale) {
          // Absence means unknown, never closed: an unresolved PR is cached
          // as null so one missing number cannot refetch on every event.
          const summary = byRef.get(key) ?? null;
          const at = now();
          if (cache.size > 200) cache.clear();
          cache.set(key, { at, summary });
          fresh.set(taskId, summary);
        }
      } catch (error) {
        if ((error?.status ?? error?.response?.status) === 401) return { status: 'disconnected' };
        if (summariesModule.isGraphqlRateLimitError?.(error) || rateLimit.isGitHubRateLimitError?.(error)) {
          // The shared cooldown also holds back every other GitHub read.
          rateLimit.noteGitHubRateLimit(error);
          return { status: 'unavailable' };
        }
        throw error;
      }
    }
    return { status: 'ok', summaries: Object.fromEntries(fresh) };
  },
  };
};

export { createTeamPullStatus };
