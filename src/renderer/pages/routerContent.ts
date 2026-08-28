/**
 * Content model for the Router page, taken from the Figma node "Main"
 * (194:3905). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * Everything here is still the design's reference value: the page is UI only,
 * so nothing is read from the main process yet.
 */

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
  /** Second line: who runs the model, or why it is the suggested one. */
  readonly detail: string;
  /** The letter drawn in the tile fronting the row, in place of a brand mark. */
  readonly initial: string;
}

export const CLOUD_MODELS: readonly CloudModel[] = [
  { id: 'tokii-cloud', name: 'Tokii Cloud', detail: 'Recommended', initial: 'T' },
  { id: 'claude-sonnet', name: 'Claude Sonnet', detail: 'Anthropic', initial: 'A' },
  { id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', detail: 'Google', initial: 'G' },
  { id: 'deepseek-v3', name: 'DeepSeek V3', detail: 'DeepSeek', initial: 'D' }
];

export const DEFAULT_CLOUD_MODEL_ID = 'claude-sonnet';

export const CLOUD_MODELS_TITLE = 'Cloud Models';
export const CLOUD_MODELS_SUBTITLE =
  'Choose the model Router uses for complex tasks. The selection is shown above.';
