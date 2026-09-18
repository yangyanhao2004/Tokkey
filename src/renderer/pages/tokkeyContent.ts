/**
 * Content model for the Tokkey page, taken from the Figma node "Main"
 * (192:2507). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * The installed list comes from `useInstalledModels`; this module owns the
 * translation from those main-process records into the strings the card draws,
 * so the components never see bytes or timestamps.
 */

import type {
  InstalledLocalModel,
  LocalModelRow,
  LocalModelRuntimeState
} from '../../shared/types';
import type { ModelActionError, ModelActionKind } from '../hooks/useInstalledModels';
import { formatFileSize } from '../../shared/byteFormatting';
import { describeModelLifecycle } from './addModelContent';

/** Shared with the sidebar so both pages resolve assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

/** A model listed under the "Installed" heading. */
export interface InstalledModel {
  readonly id: string;
  readonly name: string;
  /** Meta line, already joined with the middot the design uses. */
  readonly detail: string;
  /** Draws the badge's own mark on the row, once the badge has handed it over. */
  readonly isRecommended: boolean;
}

/**
 * Turns one model on disk into the card's view of it. The size is the file's
 * real length rather than the figure the catalog published for it, and prints
 * in the same decimal unit as the Add Model page's free-space line.
 */
export function describeInstalledModel(
  model: InstalledLocalModel,
  isRecommended = false
): InstalledModel {
  // Leads the line, as the badge's eyebrow leads its own: it is what sets this
  // row apart from the ones under it.
  const detail = [
    isRecommended ? 'Recommended' : '',
    formatFileSize(model.sizeBytes),
    'Downloaded',
    model.provider
  ]
    .filter((part) => part.length > 0)
    .join(' · ');

  return { id: model.id, name: model.name, detail, isRecommended };
}

/**
 * The one model the page puts forward above the installed list (Figma 531:613).
 * A fixed recommendation rather than a scan result, so it names the artifact it
 * stands for outright: the catalog row supplies the download, and the file name
 * is what finds the model again once it is on disk.
 */
export const RECOMMENDED_LOCAL_MODEL = {
  id: 'qwen:qwen3-5:qwen3-5-35b:Q4_K_M',
  /** Narrows the catalog scan to this one artifact in the main process. */
  catalogQuery: 'Qwen3.5 35B Q4_K_M',
  eyebrow: 'RECOMMENDED LOCAL MODEL',
  name: 'Qwen3.5 35B Q4_K_M',
  fileName: 'Qwen3.5-35B-A3B-UD-Q4_K_M.gguf',
  /** Drawn in the tile in place of a provider mark. */
  initials: 'QW'
} as const;

/**
 * What a badge button does — only ever a transfer.
 *
 * The badge stands in for the recommended model until its bytes are on disk;
 * from then on the installed list holds it, marked as recommended, and every
 * lifecycle action belongs to that row.
 */
export type RecommendedActionKind = 'download' | 'cancel';

/** The single button on the recommended badge. */
export interface RecommendedModelButton {
  readonly kind: RecommendedActionKind;
  readonly label: string;
  /** `progress` draws the button as the transfer's own progress track. */
  readonly variant: 'filled' | 'progress';
  /** True for a row the badge reports but cannot act on, e.g. one with no source. */
  readonly disabled: boolean;
}

/** Everything the one Start/Stop button reads, however the page draws it. */
export interface ModelRuntimeState {
  readonly runtime: LocalModelRuntimeState;
  readonly busyModelId: string | null;
  readonly busyAction: ModelActionKind | null;
}

/** The single lifecycle button a model carries, and what pressing it does. */
export interface ModelRuntimeButton {
  readonly kind: 'start' | 'stop';
  readonly label: string;
  readonly disabled: boolean;
  /**
   * The share of the button drawn as a progress track, or `null` for a flat
   * chip. See `PushButton`'s own `progress`.
   */
  readonly progress: number | null;
}

/**
 * How much of the button the design fills while a stop is in flight
 * (Figma 531:817: a 16px fill in a 64px button).
 *
 * A fixed share rather than a measurement: llama-server reports nothing to
 * count while it is being torn down, so the track is an affordance for "this is
 * under way", which is what the design draws.
 */
const TRANSITION_TRACK_SHARE = 0.25;

/** The Remove button, the step the lifecycle ends on once the server is down. */
export interface ModelRemoveButton {
  readonly kind: 'remove';
  readonly label: string;
  readonly disabled: boolean;
}

/**
 * The phase the lifecycle buttons read for one model.
 *
 * The runtime serves one model at a time and names it, so any other model is
 * idle whatever this one is doing.
 */
function runtimePhaseFor(modelId: string, runtime: LocalModelRuntimeState) {
  return runtime.modelId === modelId ? runtime.phase : 'idle';
}

/**
 * The Start/Stop button for one model.
 *
 * The runtime is the authority: the main process publishes `starting` when it
 * takes the request, `running` once llama-server answers its readiness check,
 * and `stopping` while the server is being torn down, so the label follows the
 * server rather than the press — a start that fails leaves the phase behind
 * `running` and the button reads "Start" again, with the reason on the row's
 * error line.
 *
 * The pending action covers only what the runtime cannot yet know: the gap
 * between the click and the first published phase.
 */
export function describeModelRuntimeButton(
  modelId: string,
  { runtime, busyModelId, busyAction }: ModelRuntimeState
): ModelRuntimeButton {
  const pending = busyModelId === modelId ? busyAction : null;
  const phase = runtimePhaseFor(modelId, runtime);

  // A stop wears the design's progress track; a start says so in words instead.
  // The track fills by a fixed share nobody measured, which on the way up reads
  // as a completion percentage the start has no way to honour — the label alone
  // carries "under way" without implying how far along it is.
  if (pending === 'stop' || phase === 'stopping') {
    return { kind: 'stop', label: 'Stopping…', disabled: true, progress: TRANSITION_TRACK_SHARE };
  }
  if (pending === 'start' || phase === 'starting') {
    return { kind: 'start', label: 'Starting…', disabled: true, progress: null };
  }
  if (phase === 'running') {
    return { kind: 'stop', label: 'Stop', disabled: pending !== null, progress: null };
  }
  return { kind: 'start', label: 'Start', disabled: pending !== null, progress: null };
}

/**
 * The Remove button for one model.
 *
 * Removing comes after stopping: while the server is starting, running, or
 * being torn down, the button beside it is the way out, so this one is inert
 * rather than silently pulling the file out from under a live process.
 */
export function describeModelRemoveButton(
  modelId: string,
  { runtime, busyModelId, busyAction }: ModelRuntimeState
): ModelRemoveButton {
  const pending = busyModelId === modelId ? busyAction : null;
  const phase = runtimePhaseFor(modelId, runtime);
  const isServing = phase === 'starting' || phase === 'running' || phase === 'stopping';

  return {
    kind: 'remove',
    label: pending === 'remove' ? 'Removing...' : 'Remove',
    disabled: pending !== null || isServing
  };
}

/**
 * The badge's model among the ones on disk.
 *
 * Matched on the artifact's file name rather than its id: a model placed by an
 * earlier version of this app, or by hand, carries no manifest, so the installed
 * list gives it a path-derived id no catalog id can equal. The file name is the
 * one thing both conventions keep, and the id is still tried first for the
 * ordinary case of a model this app downloaded itself.
 */
export function findRecommendedInstall(
  models: readonly InstalledLocalModel[] | null,
  row: LocalModelRow | null
): InstalledLocalModel | null {
  const id = row?.id ?? RECOMMENDED_LOCAL_MODEL.id;
  const fileName = (row?.fileName ?? RECOMMENDED_LOCAL_MODEL.fileName).toLowerCase();
  return models?.find(
    (model) => model.id === id || model.fileName.toLowerCase() === fileName
  ) ?? null;
}

/**
 * The installed rows in the order the card draws them: the recommended model
 * first, then the rest as the main process listed them (newest download first).
 *
 * The store orders by download time alone, so the recommended row would sink
 * below anything installed after it; pinning it keeps the one model the page
 * puts forward where the badge left it.
 */
export function orderInstalledModels(
  models: readonly InstalledLocalModel[] | null,
  recommendedModelId: string | null
): InstalledLocalModel[] {
  if (models === null) return [];
  if (recommendedModelId === null) return [...models];

  const recommended = models.filter((model) => model.id === recommendedModelId);
  const rest = models.filter((model) => model.id !== recommendedModelId);
  return [...recommended, ...rest];
}

/**
 * What a failed start, stop, or remove left for one model, or `null` when the
 * last one belongs to a different row.
 */
export function findModelActionError(
  actionError: ModelActionError | null,
  modelId: string | null
): string | null {
  if (actionError === null || modelId === null) return null;
  return actionError.modelId === modelId ? actionError.message : null;
}

/**
 * The button the badge offers for the state its model is in — always a
 * transfer, since a model already on disk has left the badge for the list.
 *
 * Only a row the catalog reports as downloadable can be pressed. A row that has
 * not arrived yet, has no source, or outgrows this Mac keeps its Download button
 * but cannot use it — there is nothing behind it that could succeed, and the
 * badge has no meta line to explain a missing button.
 */
export function describeRecommendedButtons(row: LocalModelRow | null): RecommendedModelButton[] {
  switch (row?.lifecycle) {
    case 'downloading':
      // Named for the state, not the press — see the Add Model row it matches.
      return [{ kind: 'cancel', label: 'Downloading...', variant: 'progress', disabled: false }];
    case 'downloadFailed':
      return [{ kind: 'download', label: 'Retry', variant: 'filled', disabled: false }];
    case 'downloadable':
      return [{ kind: 'download', label: 'Download', variant: 'filled', disabled: false }];
    default:
      return [{ kind: 'download', label: 'Download', variant: 'filled', disabled: true }];
  }
}

/** A line under the name, with the tone it should be read in. */
export interface RecommendedModelNote {
  readonly text: string;
  readonly tone: 'muted' | 'error';
}

/**
 * The badge's third line, or `null` when it has nothing to add. A transfer
 * reports itself in the same words the Add Model row uses, so one download reads
 * the same on both pages; otherwise a failed scan reports its reason, which no
 * button state can convey.
 */
export function describeRecommendedNote(
  row: LocalModelRow | null,
  error: string | null
): RecommendedModelNote | null {
  if (row?.lifecycle === 'downloading') {
    return { text: describeModelLifecycle(row), tone: 'muted' };
  }
  if (row?.lifecycle === 'downloadFailed') {
    return { text: describeModelLifecycle(row), tone: 'error' };
  }
  return error === null ? null : { text: error, tone: 'error' };
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
