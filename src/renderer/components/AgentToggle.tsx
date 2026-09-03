import type { CatalogAgent, HubAgent } from '../pages/agentHubContent';
import { AgentMarkTile } from './AgentMark';

export interface AgentToggleProps {
  agent: HubAgent;
  isSelected: boolean;
  disabled: boolean;
  /** Said under the agent's name: whether it could load this entry at all. */
  supportLabel: string;
  onToggle: (agent: CatalogAgent) => void;
  /** Distinguishes one dialog's toggles from another's, e.g. "manage-agent". */
  testIdPrefix: string;
}

/**
 * One agent an entry can be enabled for. The whole card is the control, so the
 * 12px box at its end is decoration the button state drives rather than a
 * second thing to click.
 *
 * Both dialogs that ask "which agents load this" draw the same card — the
 * Manage dialog over an installed entry, the Add MCP dialog over one being
 * written — so the control lives here rather than in either of them.
 */
export function AgentToggle({
  agent,
  isSelected,
  disabled,
  supportLabel,
  onToggle,
  testIdPrefix
}: AgentToggleProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isSelected}
      disabled={disabled}
      onClick={() => onToggle(agent.catalogAgent)}
      className={`flex min-w-0 flex-1 items-center justify-between rounded-[8px] border px-2 py-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40 ${
        isSelected
          ? 'border-toggle-selected-border bg-toggle-selected-bg'
          : 'border-toggle-border bg-toggle-bg'
      }`}
      data-testid={`${testIdPrefix}-${agent.id}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <AgentMarkTile agentId={agent.id} size="sm" />
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <span className="truncate text-[10px] leading-[12px] font-bold text-text-primary">
            {agent.name}
          </span>
          <span className="text-[8px] leading-[10px] text-label-eyebrow">{supportLabel}</span>
        </span>
      </span>

      <span
        className={`flex size-[12px] shrink-0 items-center justify-center rounded-[6px] text-[8px] leading-[10px] font-semibold text-white ${
          isSelected ? 'bg-toggle-check-on' : 'bg-toggle-check-off'
        }`}
        aria-hidden
      >
        {isSelected ? '✓' : ''}
      </span>
    </button>
  );
}
