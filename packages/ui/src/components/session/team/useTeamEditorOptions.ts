import React from 'react';

import { filterVisibleAgents, useAgentsStore } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMcpConfigStore, selectMcpServersForDirectory } from '@/stores/useMcpConfigStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import type { TeamOption } from './TeamMemberEditor';

/**
 * The option lists a team member's card offers: primary agents, the provider
 * catalog, installed skills and configured MCP servers. Lists live in the
 * shared stores, so opening the editor only has to make sure they are loaded
 * for the directory the team will work in (`ensureLoaded`), and the memos
 * project what arrived into picker options.
 */
export const useTeamEditorOptions = (directory: string | null) => {
  const agents = useAgentsStore((state) => state.agents);
  const loadAgents = useAgentsStore((state) => state.loadAgents);
  const skills = useSkillsStore((state) => state.skills);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const mcpState = useMcpConfigStore();
  const mcpServers = selectMcpServersForDirectory(mcpState, directory);
  const providers = useConfigStore((state) => state.providers);

  const ensureLoaded = React.useCallback((target: string | null) => {
    void loadAgents(target);
    void loadSkills(target);
    void mcpState.loadMcpConfigs({ directory: target });
    // mcpState churns with every store update; its loader is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAgents, loadSkills, mcpState.loadMcpConfigs]);

  const agentOptions: TeamOption[] = React.useMemo(
    () => filterVisibleAgents(agents)
      .filter((agent) => agent.mode !== 'subagent')
      .map((agent) => ({ value: agent.id, label: agent.name || agent.id })),
    [agents],
  );
  const modelOptions: TeamOption[] = React.useMemo(
    () => providers.flatMap((provider) => provider.models.map((model) => ({
      value: `${provider.id}/${model.id}`,
      label: `${provider.name || provider.id} · ${model.name || model.id}`,
    }))),
    [providers],
  );
  const skillOptions: TeamOption[] = React.useMemo(
    () => skills.map((skill) => ({ value: skill.name, label: skill.name })),
    [skills],
  );
  const mcpOptions: TeamOption[] = React.useMemo(
    () => mcpServers.map((server) => ({ value: server.name, label: server.name })),
    [mcpServers],
  );

  return { agentOptions, modelOptions, skillOptions, mcpOptions, ensureLoaded };
};
