/**
 * Content model for the Dashboard page, taken from the Figma node "Main"
 * (756:781). Kept apart from the components so copy and formatting can change
 * without touching markup.
 *
 * The figures come from what the router recorded in Tokkey's own database:
 * `usage_queries` for the questions asked and `usage_calls` for the model calls
 * made answering them. Cost is the exception - nothing prices a call yet, so
 * the Router card's two money figures are still the design's own reference
 * values and are marked as such below.
 */

import type { UsageQueryRecord, UsageTokenTotals } from '../../shared/types';

/** Shared with the sidebar so every page resolves assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

export const PAGE_TITLE = 'Overview';

/** One figure in a card's statistics strip, e.g. "Total tokens processed". */
export interface UsageStat {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  /** The line under the value, present only on the Router card's two figures. */
  readonly footnote?: string;
  /** Money the router did not spend, which the design prints in green. */
  readonly isSaving?: boolean;
}

export const LOCAL_USAGE_TITLE = 'Local AI usage';

/** What each figure reads before the first reading arrives. */
const PENDING_VALUE = '—';

/**
 * The "Local AI usage" strip. Prefill is everything fed to the models, cache
 * reads and writes included, and decode is what they generated, so the two add
 * up to the total.
 */
export function localUsageStats(totals: UsageTokenTotals | null): readonly UsageStat[] {
  return [
    {
      id: 'total-tokens',
      label: 'Total tokens processed',
      value: totals ? formatTokenCount(totals.totalTokens) : PENDING_VALUE
    },
    {
      id: 'prefill-tokens',
      label: 'Total prefill token',
      value: totals ? formatTokenCount(totals.prefillTokens) : PENDING_VALUE
    },
    {
      id: 'decode-tokens',
      label: 'Total decode token',
      value: totals ? formatTokenCount(totals.decodeTokens) : PENDING_VALUE
    }
  ];
}

export const ROUTER_TITLE = 'Router';

/**
 * Still the design's reference figures: no call is priced yet, so there is
 * nothing to add up. Replace both values once a price list exists - the rest of
 * the card already draws real traffic.
 */
export const ROUTER_STATS: readonly UsageStat[] = [
  {
    id: 'router-spend',
    label: 'Router Spend',
    value: '$12.40',
    footnote: 'Used from your initial $30 free credit'
  },
  {
    id: 'router-saved',
    label: 'Estimated saved cost',
    value: '$18.70',
    footnote: 'Compared with the cost of an equally capable cloud model.',
    isSaving: true
  }
];

export const RECENT_QUERIES_TITLE = 'Recent queries';
export const QUERY_BREAKDOWN_TITLE = 'Query breakdown';
export const LOAD_MORE_LABEL = 'Load more';
/** The same button, while the batch it asked for is still on its way. */
export const LOADING_MORE_LABEL = 'Loading…';

export const QUERIES_LOADING_TEXT = 'Reading usage history…';
export const NO_QUERIES_TEXT = 'No queries yet. Anything you route through Tokkey is listed here.';
/** What a query with no recorded calls is titled, rather than an empty row. */
const UNTITLED_QUERY_TEXT = 'Untitled query';

/** Tokens counted on one query or one of its steps. */
export interface QueryMetrics {
  readonly tokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One of the three figures a query or step row reports. */
export interface MetricColumn {
  readonly label: string;
  readonly value: string;
}

/**
 * The three columns in the order the design prints them. Query rows and step
 * rows both read from here so the two never drift apart. Spend and saved belong
 * beside these once calls are priced.
 */
export function metricColumns(metrics: QueryMetrics): readonly MetricColumn[] {
  return [
    { label: 'Tokens', value: formatTokenCount(metrics.tokens) },
    { label: 'Input', value: formatTokenCount(metrics.inputTokens) },
    { label: 'Output', value: formatTokenCount(metrics.outputTokens) }
  ];
}

/** The line under a query title, which counts the models it was routed to. */
export function stepCountLabel(stepCount: number): string {
  return stepCount === 1 ? '1 step' : `${stepCount} steps`;
}

/** The title a query row prints, which is the question as it was asked. */
export function queryTitle(query: UsageQueryRecord): string {
  return query.queryText.trim() || UNTITLED_QUERY_TEXT;
}

/**
 * When a query ran, in this machine's own timezone. The list is ordered by
 * time, so each row says which point in it this one is.
 */
export function formatQueryTime(epochMilliseconds: number): string {
  if (!Number.isFinite(epochMilliseconds) || epochMilliseconds <= 0) return '';
  return new Date(epochMilliseconds).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

const THOUSAND = 1_000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

/**
 * A token count at the width the cards allow. Always one decimal of the unit:
 * dropping it above ten rounded 19,924 to "20k", which reads as a round number
 * the router never recorded. "19.9k" is the same width and stays honest.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < THOUSAND) return `${Math.round(tokens)}`;
  if (tokens < MILLION) return `${scaled(tokens, THOUSAND)}k`;
  if (tokens < BILLION) return `${scaled(tokens, MILLION)}M`;
  return `${scaled(tokens, BILLION)}B`;
}

function scaled(tokens: number, unit: number): string {
  return (tokens / unit).toFixed(1);
}
