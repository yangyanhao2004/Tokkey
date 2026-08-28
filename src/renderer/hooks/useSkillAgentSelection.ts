import { useEffect, useState } from 'react';
import type { SkillAgent } from '../../shared/types';

export interface SkillAgentSelectionReading {
  /** The agents the skill is deployed to, or `null` until the reading arrives. */
  selectedAgents: SkillAgent[] | null;
  error: string | null;
}

/**
 * Which agents one skill is currently enabled for, as the main process derives
 * it from the skill's filesystem locations rather than from its catalog badges.
 *
 * This is what the Manage Skill dialog opens on, so the boxes it shows are the
 * same set the deployer will compare a saved selection against.
 */
export function useSkillAgentSelection(skillId: string): SkillAgentSelectionReading {
  const [selectedAgents, setSelectedAgents] = useState<SkillAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guards against a reading for a skill the dialog has already moved off.
    let isCurrent = true;
    setSelectedAgents(null);
    setError(null);

    void (async () => {
      try {
        const selection = await window.tokiie.getSkillAgentSelection(skillId);
        if (isCurrent) {
          setSelectedAgents(selection.selectedAgents);
        }
      } catch (cause) {
        if (isCurrent) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    return () => {
      isCurrent = false;
    };
  }, [skillId]);

  return { selectedAgents, error };
}
