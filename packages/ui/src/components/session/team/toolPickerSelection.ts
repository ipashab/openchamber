import type { TeamOption } from './TeamMemberEditor';

/** Value ids of every option, for the "select all" action of a tool list. */
export const everyOptionValue = (options: readonly TeamOption[]): string[] =>
  options.map((option) => option.value);

/**
 * Whether every option is picked. Stale entries in `selected` — ids a preset
 * carried from another instance that offers no such tool — do not count:
 * "all" is measured over the options this instance actually has.
 */
export const isEveryOptionSelected = (
  options: readonly TeamOption[],
  selected: readonly string[],
): boolean =>
  options.length > 0 && options.every((option) => selected.includes(option.value));
