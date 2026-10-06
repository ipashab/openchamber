import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getTeamLeadIdFromSession, getTeamSessionMarker } from './teamSessionMarkers';

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  parentID: 'ses_lead',
  title: 'Session',
  directory: '/repo',
  projectID: 'project',
  agent: 'build',
  cost: 0,
  time: { created: 1, updated: 2 },
  ...overrides,
} as Session);

describe('team session markers', () => {
  test('reads the teammate marker the server stamps at spawn', () => {
    const member = session({ id: 'ses_teammate', metadata: {
      openchamber: { team: { id: 'team_1', version: 1, slotId: 'member_a', role: 'teammate', name: 'Scout' } },
    } as Session['metadata'] });
    expect(getTeamSessionMarker(member)).toEqual({ id: 'team_1', version: 1, slotId: 'member_a', role: 'teammate', name: 'Scout' });
    expect(getTeamLeadIdFromSession(member)).toBe('ses_lead');
  });

  test('a teammate without a parent is nobody\'s child', () => {
    const orphan = session({ parentID: undefined, metadata: {
      openchamber: { team: { id: 'team_1', slotId: 'member_a', role: 'teammate' } },
    } as Session['metadata'] });
    expect(getTeamSessionMarker(orphan)).not.toBeNull();
    expect(getTeamLeadIdFromSession(orphan)).toBeNull();
  });

  test('lead rows and ordinary subagent children are not team members', () => {
    // Leads carry no team marker at all; subagent children have parents but
    // no marker. Both must stay out of the sidebar's auto-expansion.
    expect(getTeamLeadIdFromSession(session())).toBeNull();
    expect(getTeamLeadIdFromSession(session({ metadata: {
      openchamber: { team: { id: 'team_1', slotId: 'lead', role: 'lead' } },
    } as Session['metadata'] }))).toBeNull();
  });

  test('unrelated or malformed metadata is ignored, not fatal', () => {
    expect(getTeamSessionMarker(null)).toBeNull();
    expect(getTeamSessionMarker(session({ metadata: undefined }))).toBeNull();
    expect(getTeamSessionMarker(session({ metadata: { openchamber: { otherFeature: true } } as Session['metadata'] }))).toBeNull();
    expect(getTeamSessionMarker(session({ metadata: { openchamber: { team: { nope: 1 } } } as Session['metadata'] }))).toBeNull();
  });
});
