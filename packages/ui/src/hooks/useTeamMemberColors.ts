import React from 'react';

import type { TeamBoard } from '@/lib/team/team-board-api';
import {
  TEAM_MEMBER_COLOR_PALETTE,
  assignMemberColors,
  memberColorMapsEqual,
  readMemberColorMap,
  writeMemberColorMap,
  type TeamMemberColorMap,
} from '@/lib/team/teamMemberColors';

type ColorLookup = (slotId: string) => string | undefined;

/**
 * The identity-color lookup for one team's roster. Assignments are pinned per
 * slot in localStorage, so a reopening board shows the same hues it did
 * before, and two surfaces opened at once (the board panel and the section
 * rows) agree because they read the same store. Roster polling refreshes the
 * assignment; an unchanged roster writes nothing back. A null board — the
 * section's "not in a team" case — yields a lookup that colors nothing.
 */
export const useTeamMemberColors = (board: TeamBoard | null): ColorLookup => {
  const teamId = board?.id ?? null;
  const [stored, setStored] = React.useState<{ teamId: string; map: TeamMemberColorMap }>(() => ({
    teamId: board?.id ?? '',
    map: assignMemberColors(readMemberColorMap(board?.id ?? ''), board ? board.members.map((member) => member.slotId) : []),
  }));

  const slotIds = React.useMemo(() => (board ? board.members.map((member) => member.slotId) : []), [board]);

  // A different board is a different roster, not a member change: a fresh
  // assignment from that team's own persisted map, never the previous team's.
  if (stored.teamId !== (teamId ?? '')) {
    setStored({
      teamId: teamId ?? '',
      map: assignMemberColors(readMemberColorMap(teamId ?? ''), slotIds),
    });
  }

  React.useEffect(() => {
    if (teamId == null) return;
    setStored((current) => {
      if (current.teamId !== teamId) return current;
      const next = assignMemberColors(current.map, slotIds);
      if (memberColorMapsEqual(current.map, next)) return current;
      writeMemberColorMap(teamId, next);
      return { teamId: current.teamId, map: next };
    });
  }, [teamId, slotIds]);

  return React.useCallback<ColorLookup>((slotId: string) => {
    const index = stored.map[slotId];
    return index === undefined ? undefined : TEAM_MEMBER_COLOR_PALETTE[index % TEAM_MEMBER_COLOR_PALETTE.length];
  }, [stored.map]);
};
