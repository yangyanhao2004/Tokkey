/**
 * Content model for the Tokiie page, taken from the Figma node "Main"
 * (192:2507). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * The device card is still the design's reference value. The installed list is
 * live: it comes from `useInstalledModels`, and this module owns the
 * translation from those main-process records into the strings the card draws,
 * so the components never see bytes or timestamps.
 */

import type { InstalledLocalModel } from '../../shared/types';
import { formatFileSize } from '../../shared/byteFormatting';

/** Shared with the sidebar so both pages resolve assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

/** The connected Tokii device shown above the model list. */
export interface ConnectedDevice {
  readonly name: string;
  readonly detail: string;
  readonly status: string;
}

export const CONNECTED_DEVICE: ConnectedDevice = {
  name: 'Tokii CDEF is connected',
  detail: 'Connected via USB-C · local runtime available to supported clients',
  status: 'Connected'
};

/** A model listed under the "Installed" heading. */
export interface InstalledModel {
  readonly id: string;
  readonly name: string;
  /** Meta line, already joined with the middot the design uses. */
  readonly detail: string;
}

/** Stands in for the list while it is empty, loading, or unreadable. */
export const INSTALLED_LOADING_MESSAGE = 'Reading downloaded models…';
export const INSTALLED_EMPTY_MESSAGE = 'No models downloaded yet. Use "Add model" to download one.';

/**
 * Turns one model on disk into the card's view of it. The size is the file's
 * real length rather than the figure the catalog published for it, and prints
 * in the same decimal unit as the Add Model page's free-space line.
 */
export function describeInstalledModel(model: InstalledLocalModel): InstalledModel {
  const detail = [formatFileSize(model.sizeBytes), 'Downloaded', model.provider]
    .filter((part) => part.length > 0)
    .join(' · ');

  return { id: model.id, name: model.name, detail };
}

export const LOCAL_MODELS_FOOTNOTE =
  'Only one local model can run at a time.';

/**
 * Renders the count beside the "Installed" heading, e.g. "1 model".
 * Derived from the list so the two can never disagree.
 */
export function formatModelCount(count: number): string {
  return `${count} ${count === 1 ? 'model' : 'models'}`;
}
