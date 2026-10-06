// Team Mode marks every teammate session with `metadata.openchamber.team`
// (the memory the board route lives next to is shared with the server; see
// `packages/web/server/lib/team/service.js`, `spawnTeammateSession`). The
// sidebar reads the marker to auto-expand the lead's subtree, so a live team
// is visible in the session tree without hunting for the chevron.

import { z } from 'zod';
import type { Metadata, Session } from '@/lib/opencode/model';

const teamMarkerSchema = z.object({
  id: z.string(),
  version: z.number().optional(),
  slotId: z.string(),
  role: z.string(),
  name: z.string().optional(),
});

const markerSchema = z.object({
  openchamber: z.object({
    team: teamMarkerSchema,
  }),
});

export type TeamSessionMarker = z.infer<typeof teamMarkerSchema>;

/**
 * The team membership a session was spawned with, or null when the session is
 * not part of a team. Robust to unrelated metadata: one bad namespace must not
 * break sidebar expansion for ordinary sessions.
 */
export const getTeamSessionMarker = (session: Session | null | undefined): TeamSessionMarker | null => {
  const parsed = markerSchema.safeParse(session?.metadata as Metadata | undefined);
  return parsed.success ? parsed.data.openchamber.team : null;
};

/**
 * Teammate sessions are ordinary child sessions; the lead's id is their
 * `parentID`. Null when the session is not a teammate (leads and plain
 * subagent children included).
 */
export const getTeamLeadIdFromSession = (session: Session | null | undefined): string | null => {
  const marker = getTeamSessionMarker(session);
  if (!marker || marker.role !== 'teammate') return null;
  return session?.parentID ?? null;
};
