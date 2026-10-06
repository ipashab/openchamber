import React from 'react';
import { z } from 'zod';
import { toggleExpandedParentKey } from '../utils';

export const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents.v3';

const expandedParentsSchema = z.array(z.string());

const readExpandedParents = (): Set<string> => {
  try {
    const raw = globalThis.localStorage.getItem(SESSION_EXPANDED_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed = expandedParentsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? new Set(parsed.data) : new Set();
  } catch {
    return new Set();
  }
};

export const useExpandedParents = () => {
  const [expandedParents, setExpandedParents] = React.useState(readExpandedParents);
  const expandedParentsRef = React.useRef(expandedParents);
  expandedParentsRef.current = expandedParents;

  const toggleParent = React.useCallback((key: string) => {
    const next = toggleExpandedParentKey(expandedParentsRef.current, key);
    expandedParentsRef.current = next;
    setExpandedParents(next);
    try {
      globalThis.localStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // The mounted list keeps the user's change; a remount rereads durable storage.
    }
  }, []);

  // Expansion the app asserts for the user — a live team's subtree — without
  // taking the ability to collapse it away: adding only, never removing, so a
  // later user collapse still wins. Callers pass each key exactly once per
  // motivation (once per team), keeping their own memory of what they seeded.
  const ensureExpanded = React.useCallback((keys: readonly string[]) => {
    const missing = keys.filter((key) => !expandedParentsRef.current.has(key));
    if (missing.length === 0) return;
    const next = new Set(expandedParentsRef.current);
    for (const key of missing) next.add(key);
    expandedParentsRef.current = next;
    setExpandedParents(next);
    try {
      globalThis.localStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Same durability as a manual toggle: the mounted list keeps the seed.
    }
  }, []);

  return { expandedParents, toggleParent, ensureExpanded };
};
