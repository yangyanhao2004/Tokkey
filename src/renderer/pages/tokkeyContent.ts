/**
 * Content model for the Tokkey page, taken from the Figma node "Main"
 * (192:2507). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * The installed list comes from `useInstalledModels`; this module owns the
 * translation from those main-process records into the strings the card draws,
 * so the components never see bytes or timestamps.
 */

import type { InstalledLocalModel, LocalModelRow } from '../../shared/types';
import type { ModelActionError } from '../hooks/useInstalledModels';
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
 * What a badge button does. Downloading is the catalog's business; starting and
 * removing are the installed list's, exactly as they are for the rows below.
 */
export type RecommendedActionKind = 'download' | 'cancel' | 'start' | 'remove';

/** One button on the recommended badge, which draws either one or two. */
export interface RecommendedModelButton {
  readonly kind: RecommendedActionKind;
  readonly label: string;
  /** `progress` draws the button as the transfer's own progress track. */
  readonly variant: 'filled' | 'plain' | 'progress';
  /** True for a state the badge reports but cannot act on, e.g. "Running". */
  readonly disabled: boolean;
}

/** The state the badge draws from: what is on disk, and what the catalog knows. */
export interface RecommendedModelState {
  /** The badge's model among the installed ones, or `null` if it is not there. */
  readonly install: InstalledLocalModel | null;
  readonly isRunning: boolean;
  readonly row: LocalModelRow | null;
}

const REMOVE_BUTTON: RecommendedModelButton = {
  kind: 'remove',
  label: 'Remove',
  variant: 'plain',
  disabled: false
};

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
 * What a failed start or remove left for one model, or `null` when the last one
 * belongs elsewhere. The badge and the installed rows can name the same model,
 * so both read the failure from here and neither can miss one the other showed.
 */
export function findModelActionError(
  actionError: ModelActionError | null,
  modelId: string | null
): string | null {
  if (actionError === null || modelId === null) return null;
  return actionError.modelId === modelId ? actionError.message : null;
}

/**
 * The buttons the badge offers for the state its model is in: a download button
 * until the bytes are on disk, then the same start/remove pair the installed
 * rows below carry, since by then the badge names one of them.
 *
 * Only a row the catalog reports as downloadable can be pressed. A row that has
 * not arrived yet, has no source, or outgrows this Mac keeps its Download button
 * but cannot use it — there is nothing behind it that could succeed, and the
 * badge has no meta line to explain a missing button.
 */
export function describeRecommendedButtons({
  install,
  isRunning,
  row
}: RecommendedModelState): RecommendedModelButton[] {
  if (install) {
    return [
      { kind: 'start', label: isRunning ? 'Running' : 'Start', variant: 'filled', disabled: isRunning },
      REMOVE_BUTTON
    ];
  }

  switch (row?.lifecycle) {
    case 'downloading':
      return [{ kind: 'cancel', label: 'Cancel', variant: 'progress', disabled: false }];
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
 *
 * A start or remove the user just pressed outranks both: it is the only line
 * that answers a button which visibly did nothing.
 */
export function describeRecommendedNote(
  row: LocalModelRow | null,
  error: string | null,
  actionError: string | null
): RecommendedModelNote | null {
  if (actionError !== null) {
    return { text: actionError, tone: 'error' };
  }
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
