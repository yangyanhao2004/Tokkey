/**
 * Content model for the Dashboard page, taken from the Figma node "Main"
 * (756:781). Kept apart from the components so copy and rows can change
 * without touching markup.
 *
 * Nothing here is wired to a data source yet: the app records no aggregate
 * token count, router spend, or query history, so the values are the design's
 * own reference figures and stay in one place for whoever connects them.
 */

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

export const LOCAL_USAGE_STATS: readonly UsageStat[] = [
  { id: 'total-tokens', label: 'Total tokens processed', value: 'xx.x M' },
  { id: 'prefill-tokens', label: 'Total prefill token', value: 'xx.x' },
  { id: 'decode-tokens', label: 'Total decode token', value: 'xx.x' }
];

export const ROUTER_TITLE = 'Router';

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

/** What a query, and each model it passed through, cost and saved. */
export interface QueryMetrics {
  readonly tokens: string;
  readonly spend: string;
  readonly saved: string;
}

/** One model the router called while answering a query. */
export interface QueryStep {
  readonly modelName: string;
  readonly metrics: QueryMetrics;
}

/** A row in "Recent queries", expandable to the models it was routed through. */
export interface RecentQuery {
  readonly id: string;
  readonly title: string;
  readonly metrics: QueryMetrics;
  readonly steps: readonly QueryStep[];
}

/** One of the three figures a query or step row reports. */
export interface MetricColumn {
  readonly label: string;
  readonly value: string;
  /** Printed in green, the way the saved cost is on the Router card. */
  readonly isSaving: boolean;
}

/**
 * The three columns in the order the design prints them. Query rows and step
 * rows both read from here so the two never drift apart.
 */
export function metricColumns(metrics: QueryMetrics): readonly MetricColumn[] {
  return [
    { label: 'Tokens', value: metrics.tokens, isSaving: false },
    { label: 'Spend', value: metrics.spend, isSaving: false },
    { label: 'Saved', value: metrics.saved, isSaving: true }
  ];
}

/** The line under a query title, which counts the models it was routed to. */
export function stepCountLabel(stepCount: number): string {
  return stepCount === 1 ? '1 step' : `${stepCount} steps`;
}

export const RECENT_QUERIES: readonly RecentQuery[] = [
  {
    id: 'compare-qwen-gpt5',
    title: 'Compare Qwen and GPT-5 for this task',
    metrics: { tokens: '45.1k', spend: '$0.30', saved: '$0.27' },
    steps: [
      { modelName: 'Qwen 3.5 35B', metrics: { tokens: '12.4k', spend: '$0.00', saved: '$0.08' } },
      { modelName: 'GPT-5', metrics: { tokens: '8.2k', spend: '$0.30', saved: '$0.00' } },
      { modelName: 'Qwen 3.5 9B', metrics: { tokens: '11.4k', spend: '$0.00', saved: '$0.09' } },
      { modelName: 'Qwen 3.5 8B', metrics: { tokens: '13.1k', spend: '$0.00', saved: '$0.10' } }
    ]
  },
  {
    id: 'draft-launch-announcement',
    title: 'Draft a concise launch announcement',
    metrics: { tokens: '33.6k', spend: '$0.62', saved: '$0.09' },
    steps: [
      { modelName: 'GPT-5', metrics: { tokens: '20.2k', spend: '$0.62', saved: '$0.00' } },
      { modelName: 'Qwen 3.5 9B', metrics: { tokens: '13.4k', spend: '$0.00', saved: '$0.09' } }
    ]
  },
  {
    id: 'summarize-meeting-notes',
    title: 'Summarize the latest meeting notes',
    metrics: { tokens: '21.1k', spend: '$0.00', saved: '$0.16' },
    steps: [
      { modelName: 'Qwen 3.5 9B', metrics: { tokens: '12.7k', spend: '$0.00', saved: '$0.10' } },
      { modelName: 'Qwen 3.5 8B', metrics: { tokens: '8.4k', spend: '$0.00', saved: '$0.06' } }
    ]
  }
];
