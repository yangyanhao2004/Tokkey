/**
 * Content model for the Main pane, taken from the Figma node "Main"
 * (192:2507). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * These are the design's reference values. Nothing here reads from the main
 * process yet, so the pane renders the state Figma specifies; wiring it to
 * `window.tokiie` is a separate change.
 */

/** Shared with the sidebar so both panes resolve assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from './navigation';

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

export const INSTALLED_MODELS: readonly InstalledModel[] = [
  {
    id: 'qwen-3-5-9b',
    name: 'Qwen 3.5 9B',
    detail: '5.8 GB · Downloaded · balanced local assistant'
  }
];

export const LOCAL_MODELS_FOOTNOTE =
  'Only one local model can run at a time. Tokii makes the running model available to installed clients automatically.';

/**
 * Renders the count beside the "Installed" heading, e.g. "1 model".
 * Derived from the list so the two can never disagree.
 */
export function formatModelCount(count: number): string {
  return `${count} ${count === 1 ? 'model' : 'models'}`;
}
