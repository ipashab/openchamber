import { describe, expect, test } from 'bun:test';

import { everyOptionValue, isEveryOptionSelected } from './toolPickerSelection';

// ToolPicker lives inside TeamMemberEditor as an unexported detail; the two
// helpers below are its whole decision surface, so they carry the contract:
// bulk selection is measured over the options this instance offers, and a
// stale id from another instance never counts toward "everything picked".
const options = [
  { value: 'demo', label: 'Demo' },
  { value: 'docs', label: 'Docs' },
];

describe('tool picker bulk selection', () => {
  test('everyOptionValue maps the options to their ids', () => {
    expect(everyOptionValue(options)).toEqual(['demo', 'docs']);
    expect(everyOptionValue([])).toEqual([]);
  });

  test('isEveryOptionSelected is true only when every option is picked', () => {
    expect(isEveryOptionSelected(options, ['demo', 'docs'])).toBe(true);
    expect(isEveryOptionSelected(options, ['demo'])).toBe(false);
    expect(isEveryOptionSelected(options, [])).toBe(false);
  });

  test('a stale id from elsewhere never makes the list "all picked"', () => {
    // A preset may carry a tool this instance does not offer; the extras do
    // not matter as long as every real option is picked.
    expect(isEveryOptionSelected(options, ['demo', 'docs', 'gone'])).toBe(true);
    expect(isEveryOptionSelected(options, ['gone'])).toBe(false);
  });

  test('an empty option list is never "all picked"', () => {
    // Nothing to select means the bulk action stays out of the panel, not
    // that the member somehow has everything.
    expect(isEveryOptionSelected([], ['demo'])).toBe(false);
  });
});
