/**
 * Content model for the Dashboard page, taken from the Figma node "Main"
 * (756:781). Kept apart from the components so copy and formatting can change
 * without touching markup.
 *
 * The figures come from what the router recorded in Tokkey's own database:
 * `usage_queries` for the questions asked and `usage_calls` for the model calls
 * made answering them. Spend and savings are computed from recorded tokens
 * and the model price catalog, and refresh as the router commits new usage.
 */

import type { UsageCostTotals, UsageQueryRecord } from '../../shared/types';

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
 * The "Local AI usage" strip: what this machine's own models have run.
 *
 * Awaiting a source. These were read from the router's tables, which count its
 * cloud calls alongside anything local and so answered a different question than
 * the card asks. The figures stay blank rather than reporting router traffic as
 * local work.
 */
export function localUsageStats(): readonly UsageStat[] {
  return [
    { id: 'total-tokens', label: 'Total tokens processed', value: PENDING_VALUE },
    { id: 'prefill-tokens', label: 'Total prefill token', value: PENDING_VALUE },
    { id: 'decode-tokens', label: 'Total decode token', value: PENDING_VALUE }
  ];
}

export const ROUTER_TITLE = 'Router';

/**
 * The Router card's two money figures, added up over every call on record.
 *
 * Spend is what left for a cloud provider; saved is what the calls a local model
 * answered would have cost had a cloud model answered them instead.
 */
export function routerStats(totals: UsageCostTotals | null): readonly UsageStat[] {
  return [
    {
      id: 'router-spend',
      label: 'Router Spend',
      value: totals ? formatUsd(totals.spendUsd) : PENDING_VALUE,
      footnote: 'Used from your initial $30 free credit'
    },
    {
      id: 'router-saved',
      label: 'Estimated saved cost',
      value: totals ? formatUsd(totals.savedUsd) : PENDING_VALUE,
      footnote: 'Compared with the cost of an equally capable cloud model.',
      isSaving: true
    }
  ];
}

export const RECENT_QUERIES_TITLE = 'Recent queries';
export const QUERY_BREAKDOWN_TITLE = 'Query breakdown';
export const LOAD_MORE_LABEL = 'Load more';
/** The same button, while the batch it asked for is still on its way. */
export const LOADING_MORE_LABEL = 'Loading…';

export const QUERIES_LOADING_TEXT = 'Reading usage history…';
export const NO_QUERIES_TEXT = 'No queries yet. Anything you route through Tokkey is listed here.';
/** What a query with no recorded calls is titled, rather than an empty row. */
const UNTITLED_QUERY_TEXT = 'Untitled query';

/** What one query, or one of its steps, counted and cost. */
export interface QueryMetrics {
  readonly tokens: number;
  readonly spendUsd: number;
  readonly savedUsd: number;
}

/** One of the three figures a query or step row reports. */
export interface MetricColumn {
  readonly label: string;
  readonly value: string;
  /** Money the router did not spend, which the design prints in green. */
  readonly isSaving?: boolean;
}

/**
 * The three columns in the order the design prints them (Figma 756:815 and
 * 768:1780). Query rows and step rows both read from here so the two never
 * drift apart.
 */
export function metricColumns(metrics: QueryMetrics): readonly MetricColumn[] {
  return [
    { label: 'Tokens', value: formatTokenCount(metrics.tokens) },
    { label: 'Spend', value: formatRowUsd(metrics.spendUsd) },
    { label: 'Saved', value: formatRowUsd(metrics.savedUsd), isSaving: true }
  ];
}

/** The Router card's headline figures, at the two decimals money is read in. */
export function formatUsd(amountUsd: number): string {
  return `$${spendableAmount(amountUsd).toFixed(2)}`;
}

/**
 * One row's figure, which needs more decimals than the card does.
 *
 * Nearly every call costs around a cent, so two decimals round them all to the
 * same "$0.01" and the column stops saying anything: a step of $0.0115 and one
 * of $0.0103 are a real 12% apart. Four decimals below a dollar keep that;
 * above a dollar they are noise, so two is enough there.
 */
export function formatRowUsd(amountUsd: number): string {
  const amount = spendableAmount(amountUsd);
  if (amount === 0) return '$0.00';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  // Something was spent, but less than the smallest figure this can print. A
  // bound is honest where "$0.0000" would read as costing nothing at all.
  return amount < 0.0001 ? '<$0.0001' : `$${amount.toFixed(4)}`;
}

/** Guards every money figure against a negative or non-finite rate upstream. */
function spendableAmount(amountUsd: number): number {
  return Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
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
