import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TeamPresetMember } from '@/lib/team/team-create-api';
import { TEAM_DOMAIN_IDS, TEAM_DOMAIN_LABEL_KEYS, type TeamDomain } from '@/lib/team/team-board-api';
import { everyOptionValue, isEveryOptionSelected } from './toolPickerSelection';

export type TeamOption = { value: string; label: string };

/** The "use the default" entry of the agent and model selects. */
const DEFAULT_VALUE = '__default__';

// Base UI's SelectValue prints the raw value; map it back to the option
// label so the trigger never shows the sentinel.
const selectedLabel = (
  value: string | undefined,
  fallback: string,
  options: readonly { value: string; label: string }[],
): React.ReactNode => {
  if (value === undefined || value === DEFAULT_VALUE) return fallback;
  return options.find((option) => option.value === value)?.label ?? value;
};

const MAX_MEMBERS = 10;

const toggleInList = (list: readonly string[], value: string): string[] =>
  (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);

const toMember = (name: string): TeamPresetMember => ({
  name,
  agent: null,
  model: null,
  brief: null,
  skills: [],
  mcpServers: [],
  isLead: false,
  domain: null,
  isDomainLead: false,
});

type Props = {
  members: TeamPresetMember[];
  onChange: (members: TeamPresetMember[]) => void;
  agentOptions: TeamOption[];
  modelOptions: TeamOption[];
  skillOptions: TeamOption[];
  mcpOptions: TeamOption[];
  /**
   * Hide the "Team Lead" radio when false — the add-to-team form of the live
   * roster editor uses the same card, and a live team already has its lead.
   */
  allowLeadToggle?: boolean;
};

/**
 * A checkbox list of tools a member may use, hidden behind a button until the
 * member cares for it: an always-open grid of every skill would drown the
 * editor, while the collapsed button still shows how much was picked. The
 * list is an allow-list — nothing picked means no narrowing — so the header
 * says so whenever the selection is empty, and the bulk action flips the
 * whole list at once. Selecting every tool is still a restriction: a tool
 * installed later stays outside the list.
 */
const ToolPicker: React.FC<{
  label: string;
  emptyLabel: string;
  options: TeamOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  onReplace: (next: string[]) => void;
}> = ({ label, emptyLabel, options, selected, onToggle, onReplace }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const everything = isEveryOptionSelected(options, selected);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-[var(--interactive-hover)]"
      >
        <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 tabular-nums">{selected.length}</span>
      </button>
      {open ? (
        <div className="max-h-32 space-y-0.5 overflow-y-auto border-t border-border px-2 py-1.5">
          {options.length === 0 ? (
            <div className="py-1 text-xs text-muted-foreground">{emptyLabel}</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 pb-1">
                {selected.length === 0 ? (
                  <span className="min-w-0 text-[11px] leading-tight text-muted-foreground">
                    {t('team.create.member.toolsNoRestriction')}
                  </span>
                ) : <span aria-hidden className="min-w-0 flex-1" />}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto shrink-0 px-0 py-0 text-xs"
                  onClick={() => onReplace(everything ? [] : everyOptionValue(options))}
                >
                  {everything
                    ? t('team.create.member.toolsClearAll')
                    : t('team.create.member.toolsSelectAll')}
                </Button>
              </div>
              {options.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-center gap-2 text-xs">
                  <Checkbox
                    checked={selected.includes(option.value)}
                    onChange={() => onToggle(option.value)}
                  />
                  <span className="truncate">{option.label}</span>
                </label>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};

/**
 * The roster editor shared by the "New Team" dialog, the settings preset page
 * and the live-roster "add members" form: one card per member with its name,
 * agent, model, role brief and tool allowances. The "Team Lead" checkbox is a
 * radio in checkbox clothing — a team runs with exactly one lead, so checking
 * a member clears the others, and the lead card cannot be removed.
 */
export const TeamMemberEditor: React.FC<Props> = ({
  members,
  onChange,
  agentOptions,
  modelOptions,
  skillOptions,
  mcpOptions,
  allowLeadToggle = true,
}) => {
  const { t } = useI18n();

  const domainOptions = TEAM_DOMAIN_IDS.map((id) => ({ value: id, label: t(TEAM_DOMAIN_LABEL_KEYS[id]) }));

  const patch = (index: number, next: Partial<TeamPresetMember>) => {
    onChange(members.map((entry, position) => (position === index ? { ...entry, ...next } : entry)));
  };
  const promoteLead = (index: number) => {
    onChange(members.map((entry, position) => ({ ...entry, isLead: position === index })));
  };
  const removeAt = (index: number) => onChange(members.filter((_, position) => position !== index));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('team.create.members.title')}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={members.length >= MAX_MEMBERS}
          onClick={() => onChange([...members, toMember('')])}
        >
          <Icon name="add" className="size-3.5" />
          {t('team.create.members.add')}
        </Button>
      </div>

      {members.map((member, index) => {
        const isLead = member.isLead === true;
        return (
          <div
            key={index}
            className={cn(
              'space-y-2 rounded-lg border p-2.5',
              isLead ? 'border-[var(--status-info)]/60 bg-[var(--status-info)]/5' : 'border-border',
            )}
          >
            <div className="flex items-center gap-2">
              <Input
                value={member.name}
                onChange={(event) => patch(index, { name: event.target.value })}
                placeholder={t('team.create.member.name')}
                className="h-8 flex-1"
              />
              {allowLeadToggle ? (
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={isLead}
                    onChange={() => promoteLead(index)}
                    ariaLabel={t('team.create.member.lead')}
                  />
                  {t('team.create.member.lead')}
                </label>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                disabled={isLead || members.length <= 1}
                onClick={() => removeAt(index)}
                aria-label={t('team.create.member.remove')}
                title={t('team.create.member.remove')}
              >
                <Icon name="close" className="size-4" />
              </Button>
            </div>

            <Textarea
              value={member.brief ?? ''}
              onChange={(event) => patch(index, { brief: event.target.value })}
              placeholder={t('team.create.member.role')}
              rows={2}
              className="resize-none text-[13px]"
            />

            <div className="grid grid-cols-2 gap-2">
              <Select
                value={member.agent ?? DEFAULT_VALUE}
                onValueChange={(value) => patch(index, { agent: value === DEFAULT_VALUE ? null : value })}
                items={[
                  { value: DEFAULT_VALUE, label: t('team.create.member.agentDefault') },
                  ...agentOptions.map((option) => ({ value: option.value, label: option.label })),
                ]}
              >
                <SelectTrigger size="sm" className="h-8 w-full">
                  <SelectValue>
                    {(value) => selectedLabel(value, t('team.create.member.agentDefault'), agentOptions)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>{t('team.create.member.agentDefault')}</SelectItem>
                  {agentOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={member.model ?? DEFAULT_VALUE}
                onValueChange={(value) => patch(index, { model: value === DEFAULT_VALUE ? null : value })}
                items={[
                  { value: DEFAULT_VALUE, label: t('team.create.member.modelDefault') },
                  ...modelOptions.map((option) => ({ value: option.value, label: option.label })),
                ]}
              >
                <SelectTrigger size="sm" className="h-8 w-full">
                  <SelectValue>
                    {(value) => selectedLabel(value, t('team.create.member.modelDefault'), modelOptions)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>{t('team.create.member.modelDefault')}</SelectItem>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* The sub-team row: a domain plus, inside a domain, the "leads
                this sub-team" flag. The Team Lead sits outside every domain —
                it talks to sub-team leads, not around them. */}
            {!isLead ? (
              <div className="flex items-center gap-2">
                <Select
                  value={member.domain ?? DEFAULT_VALUE}
                  onValueChange={(value) => patch(index, {
                    domain: value === DEFAULT_VALUE ? null : (value as TeamDomain),
                    isDomainLead: value === DEFAULT_VALUE ? false : member.isDomainLead === true,
                  })}
                  items={[
                    { value: DEFAULT_VALUE, label: t('team.create.member.domainNone') },
                    ...domainOptions,
                  ]}
                >
                  <SelectTrigger size="sm" className="h-8 w-full">
                    <SelectValue>
                      {(value) => selectedLabel(value, t('team.create.member.domainNone'), domainOptions)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_VALUE}>{t('team.create.member.domainNone')}</SelectItem>
                    {domainOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {member.domain ? (
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={member.isDomainLead === true}
                      onChange={() => patch(index, { isDomainLead: !(member.isDomainLead === true) })}
                      ariaLabel={t('team.create.member.domainLead')}
                    />
                    {t('team.create.member.domainLead')}
                  </label>
                ) : null}
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
              <ToolPicker
                label={t('team.create.member.skills')}
                emptyLabel={t('team.create.member.toolsNone')}
                options={skillOptions}
                selected={member.skills}
                onToggle={(value) => patch(index, { skills: toggleInList(member.skills, value) })}
                onReplace={(next) => patch(index, { skills: next })}
              />
              <ToolPicker
                label={t('team.create.member.mcp')}
                emptyLabel={t('team.create.member.toolsNone')}
                options={mcpOptions}
                selected={member.mcpServers}
                onToggle={(value) => patch(index, { mcpServers: toggleInList(member.mcpServers, value) })}
                onReplace={(next) => patch(index, { mcpServers: next })}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
