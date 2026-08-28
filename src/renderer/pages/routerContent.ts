/**
 * Content model for the Router page, taken from the Figma node "Main"
 * (194:3905). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * The copy here is still the design's reference value; the cloud model rows
 * are drawn from the catalog the main process serves.
 */

import type { CloudModelCard } from '../../shared/types';

/** Shared with the sidebar so every page resolves assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

export const ROUTER_TOGGLE_TITLE = 'Router';
export const ROUTER_TOGGLE_DESCRIPTION =
  'Automatically send simple tasks to your Tokii and complex tasks to the selected cloud model.';

/** One of the two summary cards that report what Router routes between. */
export interface ModelSummary {
  /** Small-caps label over the card, e.g. "Local model". */
  readonly eyebrow: string;
  /** The line under the eyebrow explaining where the value comes from. */
  readonly hint: string;
  /** Icon file inside the shared icon directory. */
  readonly iconFile: string;
  /**
   * The glyph's own dimensions. The two icons are different shapes in Figma,
   * so each carries its size rather than sharing one; the renderer's CSP
   * forbids inline styles, so it travels as a class.
   */
  readonly iconClass: string;
}

export const LOCAL_MODEL_SUMMARY: ModelSummary = {
  eyebrow: 'Local model',
  hint: 'Current running model on this Mac',
  iconFile: 'router-local-model.svg',
  iconClass: 'h-[12px] w-[10.667px]'
};

export const CLOUD_MODEL_SUMMARY: ModelSummary = {
  eyebrow: 'Cloud model',
  hint: 'Selected below for complex tasks',
  iconFile: 'router-cloud-model.svg',
  iconClass: 'size-[11.789px]'
};

/** Stands in for the local summary while no local model is running. */
export const NO_LOCAL_MODEL_NAME = 'No local model running';
export const NO_LOCAL_MODEL_DETAIL = 'Start a local model from Tokii to use it here.';

/** A model listed in the "Cloud Models" grid. */
export interface CloudModel {
  readonly id: string;
  readonly name: string;
  /** Second line: the host the model is reached through. */
  readonly detail: string;
  /** The letter drawn in the tile fronting the row, in place of a brand mark. */
  readonly initial: string;
}

/**
 * Draws one catalog card as a grid row. The catalog carries connection
 * details rather than display copy, so the row's second line falls back to
 * the raw url when it is not a parsable address.
 */
export function toCloudModel(card: CloudModelCard): CloudModel {
  return {
    id: card.id,
    name: card.modelName,
    detail: hostOf(card.url),
    initial: card.modelName.charAt(0).toUpperCase()
  };
}

/** The host of an endpoint url, or the url itself when it is not parsable. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Stands in for the cloud summary until a card has been connected. */
export const NO_CLOUD_MODEL_NAME = 'No cloud model selected';
export const NO_CLOUD_MODEL_DETAIL = 'Select a model below to use it for complex tasks.';

export const CLOUD_MODELS_TITLE = 'Cloud Models';
export const CLOUD_MODELS_SUBTITLE =
  'Choose the model Router uses for complex tasks. The selection is shown above.';

/** Shown in place of the grid when the catalog offers nothing. */
export const CLOUD_MODELS_EMPTY_MESSAGE = 'No cloud models are available in this build.';

/** Said in front of whatever reason the main process gave for a failed call. */
export const CLOUD_MODELS_UNAVAILABLE_PREFIX = 'Could not load cloud models: ';
export const CLOUD_MODEL_CONNECT_FAILED_PREFIX = 'Could not connect: ';

/**
 * The label on one row's button. Selecting a model connects it, which is worth
 * naming: the click can take a moment while the gateway route is created.
 */
export function selectButtonLabel(isSelected: boolean, isConnecting: boolean): string {
  if (isConnecting) return 'Connecting...';
  return isSelected ? 'Selected' : 'Select';
}
