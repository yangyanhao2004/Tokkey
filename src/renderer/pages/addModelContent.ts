/**
 * Content model for the Add Model page, taken from the Figma node "Main"
 * (225:2181). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * These are the design's reference values. Nothing here reads from the main
 * process yet, so the page renders the state Figma specifies; wiring it to
 * `window.tokiie` is a separate change.
 */

/** Shared with the sidebar so both pages resolve assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

/** The Mac the catalog is being sized against. */
export interface HostMachine {
  readonly name: string;
  readonly detail: string;
  /** Neutral badge on the right of the card, e.g. "No local model running". */
  readonly status: string;
}

export const HOST_MACHINE: HostMachine = {
  name: 'This Mac',
  detail: 'MacBook Air 13-inch (M5) · 16 GB unified memory · macOS 26.5',
  status: 'No local model running'
};

/** One of the two capacity bars under the host card. */
export interface CapacityMeter {
  readonly id: string;
  readonly label: string;
  /** Share of the resource in use, 0-100. Shown as the reading beside the label. */
  readonly percentUsed: number;
  /**
   * Width of the filled part of the bar. Written as a class because the
   * renderer's CSP forbids inline style attributes, so the percentage cannot be
   * applied at runtime.
   */
  readonly barWidthClass: string;
  /** Line under the bar, already joined with the middot the design uses. */
  readonly footnote: string;
}

export const CAPACITY_METERS: readonly CapacityMeter[] = [
  {
    id: 'memory',
    label: 'Memory used',
    percentUsed: 82,
    barWidthClass: 'w-[82%]',
    footnote: '2.9 GB free of 16 GB'
  },
  {
    id: 'disk',
    label: 'Disk used',
    percentUsed: 13,
    barWidthClass: 'w-[13%]',
    footnote: '402 GB free of 460 GB · 3 models downloaded'
  }
];

/** A model offered in the catalog, downloaded or not. */
export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  /** Meta line, already joined with the middot the design uses. */
  readonly detail: string;
  /** `true` once the model is on disk, which turns Download into Remove. */
  readonly isDownloaded: boolean;
}

export const CATALOG_HEADING = 'Recommended for this Mac';
export const CATALOG_SUBHEADING = 'Balanced for 16 GB unified memory and Apple silicon.';
export const PROVIDER_FILTER_LABEL = 'All providers';

export const CATALOG_MODELS: readonly CatalogModel[] = [
  {
    id: 'qwen-3-5-9b',
    name: 'Qwen 3.5 9B',
    detail: '5.8 GB · Recommended · good balance of quality and setup time',
    isDownloaded: true
  },
  {
    id: 'qwen-3-5-8b',
    name: 'Qwen 3.5 8B',
    detail: '5.2 GB · efficient local assistant',
    isDownloaded: true
  },
  {
    id: 'llama-3-2-3b',
    name: 'Llama 3.2 3B',
    detail: '2.1 GB · lightweight multilingual model',
    isDownloaded: false
  },
  {
    id: 'deepseek-coder-1-3b',
    name: 'DeepSeek Coder 1.3B',
    detail: '4.4 GB · coding assistant',
    isDownloaded: false
  }
];
