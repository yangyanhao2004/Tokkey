import { useState, type ReactNode } from 'react';
import {
  ICON_BASE_PATH,
  LOCAL_USAGE_STATS,
  LOCAL_USAGE_TITLE,
  metricColumns,
  PAGE_TITLE,
  QUERY_BREAKDOWN_TITLE,
  RECENT_QUERIES,
  RECENT_QUERIES_TITLE,
  ROUTER_STATS,
  ROUTER_TITLE,
  stepCountLabel,
  type QueryMetrics,
  type QueryStep,
  type RecentQuery,
  type UsageStat
} from './dashboardContent';
import { PageShell } from '../components/PageShell';

interface SectionCardProps {
  /** The small-caps heading in the card's own strip, e.g. "Router". */
  title: string;
  /** True for the card that grows with its list, which then scrolls inside. */
  isFlexible?: boolean;
  testId: string;
  children: ReactNode;
}

/**
 * The white panel both halves of the page are drawn on: a heading strip over
 * one or more hairline-separated bands.
 */
function SectionCard({ title, isFlexible = false, testId, children }: SectionCardProps) {
  return (
    <section
      className={`flex w-full flex-col overflow-hidden rounded-[12px] border border-surface-panel-border bg-white ${
        isFlexible ? 'min-h-0 flex-1' : 'shrink-0'
      }`}
      data-testid={testId}
    >
      <h2 className="shrink-0 px-4 py-3 text-[12px] leading-[14px] font-bold text-label-eyebrow">
        {title}
      </h2>
      {children}
    </section>
  );
}

interface StatCellProps {
  stat: UsageStat;
  /** The Router card recesses its figures; the usage card leaves them on white. */
  isRecessed?: boolean;
  /** Figma fixes the two trailing usage figures rather than sharing the width. */
  widthClass?: string;
}

/** A label over a 20px figure, optionally over the sentence explaining it. */
function StatCell({ stat, isRecessed = false, widthClass = 'min-w-0 flex-1' }: StatCellProps) {
  return (
    <div
      className={`flex flex-col gap-1 p-4 ${widthClass} ${isRecessed ? 'bg-vibrant-quaternary' : ''}`}
      data-testid={`stat-${stat.id}`}
    >
      <span className="text-[10px] leading-[12px] font-semibold text-label-eyebrow">
        {stat.label}
      </span>
      <span
        className={`text-[20px] leading-[24px] font-bold ${
          stat.isSaving ? 'text-status-ok-text' : 'text-label-strong'
        }`}
      >
        {stat.value}
      </span>
      {stat.footnote && (
        <span className="text-[9px] leading-[11px] text-label-eyebrow">{stat.footnote}</span>
      )}
    </div>
  );
}

/**
 * The band of figures under a card heading. Every cell after the first carries
 * the hairline that divides it from the one before.
 */
function StatRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full shrink-0 items-stretch border-t border-dialog-divider [&>*+*]:border-l [&>*+*]:border-dialog-divider">
      {children}
    </div>
  );
}

interface MetricColumnsProps {
  metrics: QueryMetrics;
  /**
   * Query rows print a notch larger than the step rows nested inside them.
   * Figma shrinks a query row's figures to the step size once it is expanded;
   * one size is used in both states here so the row does not reflow on a click.
   */
  size: 'query' | 'step';
}

/** The Tokens/Spend/Saved trio that ends every query and step row. */
function MetricColumns({ metrics, size }: MetricColumnsProps) {
  const valueClasses = size === 'query' ? 'text-[9px] leading-[11px]' : 'text-[8px] leading-[10px]';

  return (
    <div className="flex shrink-0 items-center gap-4">
      {metricColumns(metrics).map((column) => (
        <div className="flex flex-col items-center gap-1" key={column.label}>
          <span className="text-[8px] leading-[10px] text-text-secondary">{column.label}</span>
          <span
            className={`font-bold ${valueClasses} ${
              column.isSaving ? 'text-status-ok-text' : 'text-text-primary'
            }`}
          >
            {column.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The position marker on a step row. Figma draws SF Symbols' "<n>.circle", but
 * a query can be routed through any number of models, so the badge is drawn
 * here rather than shipped as one asset per number.
 */
function StepBadge({ position }: { position: number }) {
  return (
    <svg className="block size-[10px] shrink-0" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <circle cx="5" cy="5" r="4.4" stroke="currentColor" strokeWidth="0.7" />
      <text
        x="5"
        y="5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="5.5"
        fontWeight="600"
        fill="currentColor"
      >
        {position}
      </text>
    </svg>
  );
}

/** One model a query was routed through, inside an expanded query row. */
function QueryStepRow({ step, position }: { step: QueryStep; position: number }) {
  return (
    <div className="flex w-full items-center justify-between gap-4 rounded-[8px] border border-vibrant-tertiary bg-white px-3 py-1">
      <span className="flex min-w-0 items-center gap-1 text-[9px] leading-[11px] font-semibold text-text-secondary">
        <StepBadge position={position} />
        <span className="truncate">{step.modelName}</span>
      </span>
      <MetricColumns metrics={step.metrics} size="step" />
    </div>
  );
}

interface RecentQueryRowProps {
  query: RecentQuery;
  isExpanded: boolean;
  onToggle: () => void;
}

/**
 * A query in the recent list, and - once expanded - the models it was routed
 * through. The whole header is the toggle rather than only the chevron, so the
 * row can be hit anywhere along its width and reached from the keyboard.
 */
function RecentQueryRow({ query, isExpanded, onToggle }: RecentQueryRowProps) {
  const breakdownId = `query-breakdown-${query.id}`;

  return (
    <article
      className={`flex w-full flex-col gap-3 p-4 ${isExpanded ? 'bg-vibrant-tertiary/50' : ''}`}
      data-testid={`recent-query-${query.id}`}
    >
      <button
        type="button"
        className="flex w-full items-start justify-between gap-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-primary"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={breakdownId}
        data-testid={`recent-query-toggle-${query.id}`}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[10px] leading-[12px] font-bold text-text-primary">
            {query.title}
          </span>
          <span className="text-[9px] leading-[11px] text-text-secondary">
            {stepCountLabel(query.steps.length)}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-8">
          <MetricColumns metrics={query.metrics} size="query" />
          <img
            // One asset for both states: expanding flips the chevron over.
            className={`block size-[14px] max-w-none ${isExpanded ? 'rotate-180' : ''}`}
            src={`${ICON_BASE_PATH}/main-chevron-down.svg`}
            alt=""
          />
        </span>
      </button>

      {isExpanded && (
        <div className="flex w-full flex-col gap-3" id={breakdownId}>
          <h3 className="text-[9px] leading-[11px] font-semibold text-text-secondary">
            {QUERY_BREAKDOWN_TITLE}
          </h3>
          <div className="flex w-full flex-col gap-1">
            {query.steps.map((step, index) => (
              <QueryStepRow key={step.modelName} step={step} position={index + 1} />
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * The page behind the "Dashboard" nav row: what this Mac has run locally, what
 * Router has spent and saved, and the queries it most recently routed.
 */
export function DashboardPage() {
  // At most one query is open at a time, so the list stays readable however
  // many models a query was routed through.
  const [expandedQueryId, setExpandedQueryId] = useState<string | null>(null);

  return (
    <PageShell title={PAGE_TITLE} testId="dashboard">
      <SectionCard title={LOCAL_USAGE_TITLE} testId="local-usage-card">
        <StatRow>
          {LOCAL_USAGE_STATS.map((stat, index) => (
            <StatCell
              key={stat.id}
              stat={stat}
              // Figma lets the first figure take the slack and pins the rest.
              widthClass={index === 0 ? 'min-w-0 flex-1' : 'w-[160px] shrink-0'}
            />
          ))}
        </StatRow>
      </SectionCard>

      <SectionCard title={ROUTER_TITLE} isFlexible testId="router-usage-card">
        <StatRow>
          {ROUTER_STATS.map((stat) => (
            <StatCell key={stat.id} stat={stat} isRecessed />
          ))}
        </StatRow>

        <div className="flex min-h-0 flex-1 flex-col gap-3 border-t border-dialog-divider p-4">
          <h3 className="shrink-0 text-[10px] leading-[12px] font-semibold text-label-eyebrow">
            {RECENT_QUERIES_TITLE}
          </h3>

          <div
            className="flex min-h-0 w-full flex-col divide-y divide-vibrant-tertiary overflow-y-auto rounded-[8px] border border-vibrant-tertiary"
            data-testid="recent-queries"
          >
            {RECENT_QUERIES.map((query) => (
              <RecentQueryRow
                key={query.id}
                query={query}
                isExpanded={query.id === expandedQueryId}
                onToggle={() =>
                  setExpandedQueryId((current) => (current === query.id ? null : query.id))
                }
              />
            ))}
          </div>
        </div>
      </SectionCard>
    </PageShell>
  );
}
