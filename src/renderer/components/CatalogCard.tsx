import {
  ICON_BASE_PATH,
  MANAGE_LABEL,
  WORKS_WITH_LABEL,
  describeCompatibility,
  findAgent,
  resolveCompatibilityState,
  type AgentAvailability,
  type CatalogEntry,
  type CompatibilityChip,
  type CompatibilityState
} from '../pages/agentHubContent';
import { AGENT_ARTWORK } from './AgentMark';
import { PushButton } from './PushButton';

/**
 * Only the enabled chip is drawn in the design (Figma 1051:3869 and 1051:3881),
 * which rings it in pale green. The other two states carry the same avatar and
 * say the rest with the ring: a hairline where the agent could run the entry,
 * and a drained mark where the agent is not installed at all.
 */
const CHIP_STATE_CLASSES: Record<CompatibilityState, string> = {
  enabled: 'ring-1 ring-chip-enabled-ring',
  available: 'ring-1 ring-black/8',
  unavailable: 'opacity-40 grayscale'
};

interface CompatibilityChipProps {
  chip: CompatibilityChip;
  availability: AgentAvailability;
}

/**
 * One agent's standing with a catalog entry, drawn as the agent's round mark.
 * An enabled entry adds the green check that overhangs the mark's bottom-right
 * corner, so neither this box nor the row it sits in may clip.
 */
function CompatibilityChipMark({ chip, availability }: CompatibilityChipProps) {
  const agent = findAgent(chip.agentId);
  if (!agent) {
    return null;
  }

  const artwork = AGENT_ARTWORK[chip.agentId];
  // Detection has the last word: an agent that is not on this machine greys out
  // however the entry describes itself.
  const state = resolveCompatibilityState(chip, availability);

  return (
    <span
      className="relative flex size-[20px] shrink-0"
      title={describeCompatibility(chip.agentId, state)}
      data-testid={`compat-chip-${chip.agentId}`}
    >
      <span
        className={`flex size-full items-center justify-center overflow-hidden rounded-full ${artwork.avatarClass} ${CHIP_STATE_CLASSES[state]}`}
      >
        <img
          className={`block max-w-none ${artwork.avatarMarkClass}`}
          src={`${ICON_BASE_PATH}/${artwork.avatarFile}`}
          alt=""
        />
      </span>

      {state === 'enabled' && (
        <span
          className="absolute right-[-4px] bottom-[-3px] flex size-[12px] items-center justify-center rounded-full bg-status-live text-[8px] leading-[10px] font-black text-white"
          aria-hidden
        >
          ✓
        </span>
      )}
    </span>
  );
}

export interface CatalogCardProps {
  entry: CatalogEntry;
  availability: AgentAvailability;
  /** Omitted for entries with nothing to manage yet, which disables the button. */
  onManage?: () => void;
}

/**
 * One skill or MCP: what it is on top, which agents it works with underneath.
 * The card is at least as tall as the design's fixed 148px but grows rather
 * than clipping, since a longer description would otherwise spill out.
 */
export function CatalogCard({ entry, availability, onManage }: CatalogCardProps) {
  return (
    <article
      className="flex min-h-[148px] flex-col justify-between gap-4 rounded-[12px] border border-vibrant-tertiary p-4"
      data-testid={`catalog-entry-${entry.id}`}
    >
      <div className="flex w-full flex-col gap-1.5">
        <div className="flex w-full items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-[12px] leading-[14px] font-bold text-text-primary">
            {entry.name}
          </h3>
          <span className="shrink-0 text-[8px] leading-[10px] text-text-secondary">
            {entry.source}
          </span>
        </div>
        {/* Skill descriptions are written for agents and run long; clamping them
            keeps every card the height the design draws. */}
        <p className="line-clamp-3 w-full text-[10px] leading-[12px] text-text-secondary" title={entry.description}>
          {entry.description}
        </p>
      </div>

      <div className="flex w-full flex-col gap-2">
        <span className="text-[8px] leading-[10px] font-bold uppercase text-label-section">
          {WORKS_WITH_LABEL}
        </span>

        <div className="flex w-full items-center justify-between gap-2">
          {/* Wider than Figma's 4px: the check badge overhangs its own chip,
              so a tighter gap would sit it on top of the next one. */}
          <div className="flex items-center gap-2">
            {entry.compatibility.map((chip) => (
              <CompatibilityChipMark key={chip.agentId} chip={chip} availability={availability} />
            ))}
          </div>

          <PushButton
            variant="plain-dark"
            onClick={onManage}
            disabled={onManage === undefined}
            testId={`catalog-manage-${entry.id}`}
          >
            {MANAGE_LABEL}
          </PushButton>
        </div>
      </div>
    </article>
  );
}
