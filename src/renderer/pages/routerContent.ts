/**
 * Content model for the Router page, taken from the Figma node "Main"
 * (194:3905). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * The copy here is still the design's reference value; the cloud model rows
 * are drawn from the catalog the main process serves.
 */

import type {
  CloudModelCard,
  InstalledLocalModel,
  LocalModelRuntimeState,
  RouterRuntimeState
} from '../../shared/types';
import type { RouterStartBlockReason } from '../hooks/useRouterStartGate';
import type { RouteId } from '../routing';

/** Shared with the sidebar so every page resolves assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

export const ROUTER_TOGGLE_TITLE = 'Router';
export const ROUTER_TOGGLE_DESCRIPTION =
  'Automatically send simple tasks to your Tokkey and complex tasks to the selected cloud model.';

/** Said in front of whatever reason the main process gave for a failed start. */
export const ROUTER_START_FAILED_PREFIX = 'Could not start Router: ';

/**
 * The line inside the card reporting what the router is actually doing. The
 * switch itself only shows on or off, so the port it took - which is rarely the
 * 5033 default when something else already holds it - is reported here.
 *
 * A failed start is deliberately not one of these: it travels through
 * `routerErrorMessage` so the page can say it outside the card.
 */
export function routerStatusMessage(state: RouterRuntimeState): string | null {
  switch (state.phase) {
    case 'starting':
      return 'Starting Router...';
    case 'running':
      return `Running on port ${state.port}.`;
    default:
      return null;
  }
}

/**
 * What to say when the switch was clicked but the router was never asked to
 * start, because one of its requirements was not met. Each line names the one
 * move that clears it, and where that move is made on another page, the words
 * naming the page are the link to it.
 */
export const ROUTER_REQUIRES_SIGN_IN_MESSAGE =
  'Router needs a signed-in Tokkey account. Your session has ended or never started. Sign in here.';
export const ROUTER_REQUIRES_DEVICE_MESSAGE =
  'You hub key is not inserted. Insert it, start a local model and try again.';
export const ROUTER_REQUIRES_LOCAL_MODEL_MESSAGE =
  'No local model is running. Start a local model from Tokkey page and try again.';

/** The words inside those lines that open a page rather than only being read. */
export const ROUTER_SIGN_IN_LINK_LABEL = 'Sign in here.';
export const ROUTER_TOKKEY_LINK_LABEL = 'Tokkey page';

/** One line under the toggle card, split around the words that are a link. */
export interface RouterNotice {
  readonly before: string;
  /** Null for a line with nowhere to go, which most of them are. */
  readonly link: { readonly label: string; readonly route: RouteId } | null;
  readonly after: string;
}

/**
 * Splits a line at the words that lead somewhere, so the copy above stays one
 * readable sentence instead of being assembled from fragments. A label the
 * sentence does not carry leaves the line unlinked rather than breaking it.
 */
function linkedNotice(message: string, label: string, route: RouteId): RouterNotice {
  const labelStart = message.indexOf(label);
  if (labelStart === -1) return plainNotice(message);
  return {
    before: message.slice(0, labelStart),
    link: { label, route },
    after: message.slice(labelStart + label.length)
  };
}

/** A line the user can only read. */
function plainNotice(message: string): RouterNotice {
  return { before: message, link: null, after: '' };
}

/** The line for an unmet requirement, or null when nothing is blocking. */
export function routerRequirementNotice(
  blockedBy: RouterStartBlockReason | null
): RouterNotice | null {
  switch (blockedBy) {
    case 'signedOut':
      return linkedNotice(ROUTER_REQUIRES_SIGN_IN_MESSAGE, ROUTER_SIGN_IN_LINK_LABEL, 'sign-in');
    case 'deviceMissing':
      return plainNotice(ROUTER_REQUIRES_DEVICE_MESSAGE);
    case 'modelNotRunning':
      return linkedNotice(ROUTER_REQUIRES_LOCAL_MODEL_MESSAGE, ROUTER_TOKKEY_LINK_LABEL, 'tokkey');
    default:
      return null;
  }
}

/** Why the last start failed, or null while nothing has failed. */
export function routerErrorMessage(state: RouterRuntimeState): string | null {
  if (state.phase !== 'error') return null;
  return `${ROUTER_START_FAILED_PREFIX}${state.error ?? 'unknown error'}`;
}

/**
 * The same failure as a line, since the page draws one notice whether it is
 * reporting a refused click or a failed start. A failure leads nowhere: the
 * reason came from the router itself, not from a page the user can visit.
 */
export function routerErrorNotice(state: RouterRuntimeState): RouterNotice | null {
  const message = routerErrorMessage(state);
  return message === null ? null : plainNotice(message);
}

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
export const NO_LOCAL_MODEL_DETAIL = 'Start a local model from Tokkey to use it here.';

/** Said in place of the address while a running model has not published one. */
export const LOCAL_MODEL_RUNNING_DETAIL = 'Running on this Mac';

/** The name and detail one of the two summary cards draws for its model. */
export interface ModelSummaryRow {
  readonly name: string;
  readonly detail: string;
}

/**
 * The local model Router would route simple tasks to, or null while none is
 * running - which is every phase but `running`, since a model still loading
 * cannot answer yet.
 *
 * The runtime names the model by id, so the installed list is what turns that
 * into the name it was downloaded under. A model the list has not caught up
 * with is still shown, under its id, rather than reading as nothing running.
 */
export function describeRunningLocalModel(
  runtime: LocalModelRuntimeState,
  installedModels: readonly InstalledLocalModel[] | null
): ModelSummaryRow | null {
  if (runtime.phase !== 'running' || runtime.modelId === null) return null;

  const installed = installedModels?.find((model) => model.id === runtime.modelId);
  return {
    name: installed?.name ?? runtime.modelId,
    // The address it serves on, as the cloud card reports the host it reaches.
    detail: runtime.endpoint === null ? LOCAL_MODEL_RUNNING_DETAIL : hostOf(runtime.endpoint)
  };
}

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
