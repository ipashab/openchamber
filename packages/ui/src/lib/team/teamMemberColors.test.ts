import { describe, expect, test } from 'bun:test';

import {
  TEAM_MEMBER_COLOR_PALETTE,
  assignMemberColors,
  memberColorMapsEqual,
} from './teamMemberColors';

describe('assignMemberColors', () => {
  test('assigns distinct palette indices to a fresh roster in roster order', () => {
    const map = assignMemberColors({}, ['lead', 'a', 'b']);
    expect(map).toEqual({ lead: 0, a: 1, b: 2 });
  });

  test('pins a member through removals, additions and reordering elsewhere', () => {
    const before = assignMemberColors({}, ['lead', 'a', 'b', 'c']);
    // `b` leaves, two members join, and the lead moved down the roster: the
    // survivors must not change hue while the newcomer reuses the freed slot.
    const after = assignMemberColors(before, ['a', 'c', 'd', 'e', 'lead']);
    expect(after.a).toBe(before.a);
    expect(after.c).toBe(before.c);
    expect(after.lead).toBe(before.lead);
    expect(after.d).toBe(before.b);
    expect(after.e).toBe(4);
  });

  test('keeps colors stable when only the order changes', () => {
    const before = assignMemberColors({}, ['a', 'b', 'c']);
    const after = assignMemberColors(before, ['c', 'b', 'a']);
    expect(memberColorMapsEqual(before, after)).toBe(true);
  });

  test('wraps rosters larger than the palette instead of failing', () => {
    const slots = Array.from({ length: TEAM_MEMBER_COLOR_PALETTE.length + 3 }, (_, index) => `slot-${index}`);
    const map = assignMemberColors({}, slots);
    slots.forEach((slotId, index) => {
      // Everyone gets a valid index; past the palette the hue repeats.
      expect(map[slotId]).toBe(index % TEAM_MEMBER_COLOR_PALETTE.length);
    });
  });

  test('repairs corrupted assignments instead of trusting them', () => {
    // Two slots claim the same index; one claims an out-of-range value.
    const repaired = assignMemberColors({ a: 2, b: 2, c: 99 }, ['a', 'b', 'c']);
    const values = Object.values(repaired);
    expect(new Set(values).size).toBe(3);
    expect(values.every((value) => value >= 0 && value < TEAM_MEMBER_COLOR_PALETTE.length)).toBe(true);
    // The healthy entry keeps its hue through the repair.
    expect(repaired.a).toBe(2);
  });

  test('drops stale entries for slots that left the roster', () => {
    const map = assignMemberColors({ gone: 5, stays: 1 }, ['stays']);
    expect(map).toEqual({ stays: 1 });
  });
});

describe('memberColorMapsEqual', () => {
  test('compares by entries, not by reference', () => {
    expect(memberColorMapsEqual({ a: 0 }, { a: 0 })).toBe(true);
    expect(memberColorMapsEqual({ a: 0 }, { a: 1 })).toBe(false);
    expect(memberColorMapsEqual({ a: 0 }, { a: 0, b: 1 })).toBe(false);
    expect(memberColorMapsEqual({}, {})).toBe(true);
  });
});
