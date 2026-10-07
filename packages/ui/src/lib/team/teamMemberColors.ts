// Identity colors for team members: display-only hues that answer "which
// member is this?" on the board, in the roster and in the task details. The
// same agent can occupy several member slots, so a color binds to the slot
// instance, not to the agent. The palette reuses syntax tokens — theme rules
// sanction syntax colors for entity markers, which keeps every theme legible
// without hardcoding hex values.

import { z } from 'zod';

// Ordered by how reliably the roles keep distinct hues across the shipped
// themes: `keyword`, `type` and `string` diverge everywhere, while `variable`
// collapses into the foreground in a few light themes, so it comes last.
export const TEAM_MEMBER_COLOR_PALETTE = [
  'var(--syntax-keyword)',
  'var(--syntax-type)',
  'var(--syntax-string)',
  'var(--syntax-number)',
  'var(--syntax-function)',
  'var(--syntax-operator)',
  'var(--syntax-variable)',
] as const;

/** slotId → palette index. Slot ids are unique per member instance. */
export type TeamMemberColorMap = Readonly<Record<string, number>>;

const firstFreeIndex = (taken: ReadonlySet<number>): number => {
  for (let index = 0; index < TEAM_MEMBER_COLOR_PALETTE.length; index += 1) {
    if (!taken.has(index)) return index;
  }
  return -1;
};

/**
 * Incremental assignment, one team at a time. A member keeps the index it
 * already had — additions, removals and reordering elsewhere on the roster
 * never recolor it — while a new member takes the smallest unoccupied index,
 * which naturally reuses the slot a removed member freed. Rosters larger than
 * the palette wrap: far-apart members share a hue instead of a stranger
 * losing theirs. Corrupted storage never reaches here: the storage reader's
 * schema rejects non-integer and negative indices, and duplicates in an
 * otherwise-valid map resolve to fresh assignments below.
 */
export const assignMemberColors = (previous: TeamMemberColorMap, slotIds: readonly string[]) => {
  const result: Record<string, number> = {};
  const taken = new Set<number>();
  const unassigned: string[] = [];
  for (const slotId of slotIds) {
    const index = previous[slotId];
    const slot = index === undefined ? null : index % TEAM_MEMBER_COLOR_PALETTE.length;
    if (slot !== null && !taken.has(slot)) {
      result[slotId] = slot;
      taken.add(slot);
    } else {
      unassigned.push(slotId);
    }
  }
  let wrapped = 0;
  for (const slotId of unassigned) {
    const free = firstFreeIndex(taken);
    // A full palette wraps to the front instead of failing: two members share
    // a hue, and the name label beside the color keeps them distinguishable.
    const slot = free === -1 ? wrapped % TEAM_MEMBER_COLOR_PALETTE.length : free;
    if (free === -1) wrapped += 1;
    result[slotId] = slot;
    taken.add(slot);
  }
  return result satisfies TeamMemberColorMap;
};

export const memberColorMapsEqual = (left: TeamMemberColorMap, right: TeamMemberColorMap): boolean => {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
};

const storageEntrySchema = z.record(z.string(), z.number().int().min(0));
const storageSchema = z.record(z.string(), storageEntrySchema);

const STORAGE_KEY = 'oc.teamMemberColors.v1';

/**
 * The stored assignment for one team. Colors are display-only, so unreadable
 * or malformed storage simply starts a fresh assignment — losing a hue is an
 * acceptable price for never rendering a wrong hint.
 */
export const readMemberColorMap = (teamId: string): TeamMemberColorMap => {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = storageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data[teamId] ?? {} : {};
  } catch {
    return {};
  }
};

/** Persist one team's assignment next to the others, best-effort like the board's own view prefs. */
export const writeMemberColorMap = (teamId: string, map: TeamMemberColorMap): void => {
  try {
    const stored = readMemberColorStore();
    stored[teamId] = map;
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The mounted roster keeps its colors for this open; persistence is a nicety.
  }
};

const readMemberColorStore = (): Record<string, TeamMemberColorMap> => {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = storageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};
