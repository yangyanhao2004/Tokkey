/**
 * Content model for the Add Model page, taken from the Figma node "Main"
 * (225:2181). Kept apart from the components so copy and presentation rules can
 * change without touching markup.
 *
 * Everything on this page is live: the host machine's memory and disk readings
 * come from `useHostSnapshot`, and the catalog rows from `useLocalModelCatalog`.
 * This module owns the translation from those main-process records into the
 * strings and buttons the card draws, so the components never see bytes or
 * lifecycle enums.
 */

import type {
  LocalModelCapability,
  LocalModelLifecycle,
  LocalModelRow
} from '../../shared/types';
import { formatBinaryGB, formatDecimalGB, formatFileSize } from '../../shared/byteFormatting';

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

/** What the row's single button does when pressed. */
export type CatalogActionKind = 'download' | 'cancel' | 'deploy' | 'remove';

/**
 * The one action a row offers, or `null` when the row is not actionable.
 * `progress` draws the button as the transfer's own progress track.
 */
export interface CatalogModelAction {
  readonly kind: CatalogActionKind;
  readonly label: string;
  readonly variant: 'filled' | 'tinted' | 'progress';
}

/** A catalog row as the card draws it: two lines of text and one button. */
export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  /** Meta line, already joined with the middot the design uses. */
  readonly detail: string;
  readonly action: CatalogModelAction | null;
  /**
   * Read-only chip shown where the button would be, for a row that has arrived
   * somewhere rather than offering a next step, e.g. "Downloaded".
   */
  readonly status: string | null;
  /** Transfer progress for a `progress` action; `null` for every other row. */
  readonly progress: number | null;
}

export const CATALOG_HEADING = 'Recommended for this Mac';
/** Stands in until the first scan reports what this Mac can actually run. */
export const CATALOG_SUBHEADING = 'Sizing the catalog against this Mac…';
export const PROVIDER_FILTER_LABEL = 'All providers';
export const CATALOG_LOADING_MESSAGE = 'Loading the model catalog…';
export const CATALOG_EMPTY_MESSAGE = 'No models match this filter.';
export const CATALOG_SEARCH_LABEL = 'Search models';
export const CATALOG_SEARCH_PLACEHOLDER = 'Search models by name, e.g. "qwen3 4b"';

/**
 * The catalog runs to thousands of rows, so a search has to narrow a name the
 * user only half remembers. Every whitespace-separated word must appear
 * somewhere in the row, in any order — "qwen 4b" finds "Qwen3 4B Q4_K_M" — and
 * the file name is searched too, so a quantization like "q4_k_m" matches even
 * when the display name spells it differently.
 */
export function matchesModelQuery(model: LocalModelRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return true;

  const haystack = [model.name, model.series, model.provider, model.fileName]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The rows a search leaves standing, in the order the scan reported them. */
export function filterCatalogModels(models: readonly LocalModelRow[], query: string): LocalModelRow[] {
  return models.filter((model) => matchesModelQuery(model, query));
}

/**
 * What stands in for an empty list: a search that found nothing names the term
 * it failed on, so the reason is never mistaken for an empty catalog.
 */
export function describeEmptyCatalog(isLoading: boolean, query: string): string {
  if (isLoading) return CATALOG_LOADING_MESSAGE;
  return query.trim().length > 0 ? `No models match “${query.trim()}”.` : CATALOG_EMPTY_MESSAGE;
}

const DOWNLOAD_ACTION: CatalogModelAction = { kind: 'download', label: 'Download', variant: 'filled' };
// Reads as the state it is in rather than the press it takes; the "×" the
// progress button draws is what says the press cancels (Figma 531:1355).
const CANCEL_ACTION: CatalogModelAction = {
  kind: 'cancel',
  label: 'Downloading...',
  variant: 'progress'
};
const RETRY_ACTION: CatalogModelAction = { kind: 'download', label: 'Retry', variant: 'filled' };
const RETRY_START_ACTION: CatalogModelAction = { kind: 'deploy', label: 'Retry start', variant: 'filled' };

/**
 * A row with no source, or one this Mac cannot hold, offers no button at all:
 * its meta line already carries the reason, and an inert button would only
 * invite a press that has to fail.
 *
 * A finished download offers none either — this page's job ends once the bytes
 * are on disk, and deleting them belongs to the Tokkey page's installed list,
 * so the row reports "Downloaded" instead.
 */
const LIFECYCLE_ACTIONS: Record<LocalModelLifecycle, CatalogModelAction | null> = {
  downloadable: DOWNLOAD_ACTION,
  pendingArtifact: null,
  downloading: CANCEL_ACTION,
  downloaded: null,
  downloadFailed: RETRY_ACTION,
  deployPreparing: null,
  deployed: null,
  deployStopping: null,
  deployFailed: RETRY_START_ACTION,
  unsupported: null
};

/** Read-only chips for rows that report a state rather than offer an action. */
const LIFECYCLE_STATUS: Partial<Record<LocalModelLifecycle, string>> = {
  downloaded: 'Downloaded',
  deployed: 'Running'
};

/**
 * Status half of the meta line. A reported error always wins over the state.
 * Shared with the Tokkey page's recommended badge so one download reads the same
 * wherever it is watched from.
 */
export function describeModelLifecycle(model: LocalModelRow): string {
  switch (model.lifecycle) {
    case 'downloading':
      return model.progress === null
        ? 'downloading'
        : `downloading ${Math.round(model.progress * 100)}%`;
    case 'downloaded':
      return 'ready to start';
    case 'downloadFailed':
      return model.error ?? 'download failed';
    case 'deployPreparing':
      return 'starting…';
    case 'deployed':
      return 'running';
    case 'deployStopping':
      return 'stopping…';
    case 'deployFailed':
      return model.error ?? 'failed to start';
    case 'pendingArtifact':
      return model.error ?? 'waiting for a download source';
    // Reached only when the artifact has a working source but outgrows the free
    // space; a row with no source carries its own error instead.
    case 'unsupported':
      return model.error ?? 'too big for this Mac';
    default:
      return 'ready to download';
  }
}

/**
 * Turns one main-process catalog row into the card's view of it.
 *
 * The size prints in the same decimal GB as the card's free-space line, so the
 * two can be read against each other. That makes it larger than the figure the
 * catalog publishes for the same file — the catalog quotes GiB — but matching
 * the number the download is actually gated on matters more here.
 * A missing size is dropped from the meta line rather than printed as "0 GB".
 */
export function describeCatalogModel(model: LocalModelRow): CatalogModel {
  const detail = [
    model.sizeBytes === null ? '' : formatFileSize(model.sizeBytes),
    model.provider,
    describeModelLifecycle(model)
  ]
    .filter((part) => part.length > 0)
    .join(' · ');

  return {
    id: model.id,
    name: model.name,
    detail,
    action: LIFECYCLE_ACTIONS[model.lifecycle],
    status: LIFECYCLE_STATUS[model.lifecycle] ?? null,
    progress: model.lifecycle === 'downloading' ? model.progress : null
  };
}

/**
 * The card's subheading: what the recommendation is actually based on. Falls
 * back to the placeholder while no capability reading exists, so the line never
 * claims a number the app has not measured.
 */
export function describeCatalogCapability(capability: LocalModelCapability | null): string {
  if (!capability?.totalRamBytes) {
    return CATALOG_SUBHEADING;
  }
  const memory = `Balanced for ${formatBinaryGB(capability.totalRamBytes)} of memory`;
  return capability.freeDiskBytes === null
    ? `${memory}.`
    : `${memory}, ${formatDecimalGB(capability.freeDiskBytes)} free on disk.`;
}
