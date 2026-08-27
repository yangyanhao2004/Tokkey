/**
 * Content model for the Add Model page, taken from the Figma node "Main"
 * (225:2181). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * The host machine's live memory and disk readings come from the main process
 * through `useHostSnapshot`. The catalog rows are still the design's reference
 * values; wiring them to `window.tokiie` is a separate change.
 */

/** Shared with the sidebar so both pages resolve assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

/**
 * The Mac the catalog is being sized against. The model, chip, memory and OS
 * line comes from `HostSnapshot.machine`, so only the fixed copy lives here.
 */
export interface HostMachine {
  readonly name: string;
  /** Subtitle shown until the first host reading arrives. */
  readonly placeholderDetail: string;
  /** Neutral badge on the right of the card, e.g. "No local model running". */
  readonly status: string;
}

export const HOST_MACHINE: HostMachine = {
  name: 'This Mac',
  placeholderDetail: 'Reading this Mac…',
  status: 'No local model running'
};

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
