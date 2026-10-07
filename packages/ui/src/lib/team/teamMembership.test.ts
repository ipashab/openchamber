import { beforeEach, describe, expect, test } from 'bun:test';

import { useTeamMembershipStore } from './teamMembership';

describe('useTeamMembershipStore', () => {
  beforeEach(() => {
    useTeamMembershipStore.setState({ sessionTeams: {} });
  });

  test('publishes and clears a session team without touching other sessions', () => {
    const { setSessionTeam } = useTeamMembershipStore.getState();
    setSessionTeam('ses_lead', 'team_1');
    useTeamMembershipStore.getState().setSessionTeam('ses_member', 'team_2');

    expect(useTeamMembershipStore.getState().sessionTeams).toEqual({
      ses_lead: 'team_1',
      ses_member: 'team_2',
    });

    // Dissolved team: the stale key is gone, the other session is intact.
    useTeamMembershipStore.getState().setSessionTeam('ses_lead', null);
    expect(useTeamMembershipStore.getState().sessionTeams).toEqual({ ses_member: 'team_2' });
  });

  test('a repeated write of the same answer changes nothing', () => {
    const { setSessionTeam } = useTeamMembershipStore.getState();
    setSessionTeam('ses_lead', 'team_1');
    const before = useTeamMembershipStore.getState();
    useTeamMembershipStore.getState().setSessionTeam('ses_lead', 'team_1');

    expect(useTeamMembershipStore.getState()).toBe(before);
  });
});
