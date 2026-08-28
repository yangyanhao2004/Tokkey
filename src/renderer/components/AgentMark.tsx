import { ICON_BASE_PATH, type AgentId } from '../pages/agentHubContent';

/** The two tile sizes the design draws an agent mark in. */
export type AgentMarkSize = 'sm' | 'md';

interface AgentArtwork {
  /** Mark for the agent's tile, drawn over `tileClass`. */
  readonly markFile: string;
  readonly tileClass: string;
  /** Glyph size per tile size, since Figma insets the mark by a fraction of the box. */
  readonly markClass: Readonly<Record<AgentMarkSize, string>>;
  /** Round mark for a compatibility chip, drawn over `avatarClass`. */
  readonly avatarFile: string;
  readonly avatarClass: string;
  readonly avatarMarkClass: string;
}

/**
 * Each agent's own artwork, from the Amis PC library: the row tile (Claude
 * 426:910, Codex 426:923) and the chip avatar (Claude 1051:3869, Codex
 * 1051:3881). Both designs size the mark as a fraction of the box it sits in,
 * so every dimension here stays explicit rather than being filled.
 *
 * These are classes rather than style attributes because the renderer's CSP
 * forbids inline styles, and they live beside the components that draw them
 * rather than in the content module, which owns copy instead of appearance.
 */
export const AGENT_ARTWORK: Record<AgentId, AgentArtwork> = {
  'claude-code': {
    markFile: 'agent-claude-mark.svg',
    // A flat brand fill lit by the white top-down wash Figma lays over it.
    tileClass: 'bg-agent-claude bg-linear-to-b from-white/20 to-transparent',
    // Figma insets the mark 10% on every side of the tile.
    markClass: { sm: 'size-[19.2px]', md: 'size-[22.4px]' },
    // The chip avatar ships its own tinted disc, so the box behind it is bare.
    avatarFile: 'agent-claude-avatar.svg',
    avatarClass: '',
    avatarMarkClass: 'size-[20px]'
  },
  codex: {
    markFile: 'agent-codex-mark.png',
    // Figma's tile is plain white; the hairline keeps it off the white card.
    tileClass: 'bg-white ring-1 ring-tile-border',
    // Inset 5% top and bottom, and near enough square to letterbox itself.
    markClass: { sm: 'size-[21.6px] object-contain', md: 'size-[25.2px] object-contain' },
    avatarFile: 'agent-codex-mark.png',
    avatarClass: 'bg-agent-codex/10',
    avatarMarkClass: 'size-[14px] object-contain'
  }
};

/** Tile geometry per size: 28px fronting an agent card, 24px inside the dialog. */
const TILE_CLASSES: Readonly<Record<AgentMarkSize, string>> = {
  sm: 'size-6 rounded-[4.941px]',
  md: 'size-7 rounded-[5.385px]'
};

interface AgentMarkTileProps {
  agentId: AgentId;
  size?: AgentMarkSize;
}

/**
 * The tile fronting an agent, on its card and in the Manage Skill dialog. Each
 * agent brings its own background and mark, so unlike the shared `IconTile`
 * this one carries no recess of its own — the artwork is the tile.
 */
export function AgentMarkTile({ agentId, size = 'md' }: AgentMarkTileProps) {
  const artwork = AGENT_ARTWORK[agentId];

  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden ${TILE_CLASSES[size]} ${artwork.tileClass}`}
    >
      <img
        className={`block max-w-none ${artwork.markClass[size]}`}
        src={`${ICON_BASE_PATH}/${artwork.markFile}`}
        alt=""
      />
    </span>
  );
}
