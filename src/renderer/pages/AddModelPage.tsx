import type { HostResourceGauge } from '../../shared/types';
import {
  CATALOG_EMPTY_MESSAGE,
  CATALOG_HEADING,
  CATALOG_LOADING_MESSAGE,
  HOST_MACHINE,
  ICON_BASE_PATH,
  PROVIDER_FILTER_LABEL,
  describeCatalogCapability,
  describeCatalogModel,
  type CatalogActionKind,
  type CatalogModel
} from './addModelContent';
import { useHostSnapshot } from '../hooks/useHostSnapshot';
import { ALL_PROVIDERS, useLocalModelCatalog } from '../hooks/useLocalModelCatalog';
import { IconTile } from '../components/IconTile';
import { PageShell } from '../components/PageShell';
import { PopUpButton, type PopUpOption } from '../components/PopUpButton';
import { PushButton } from '../components/PushButton';
import { TitleBlock } from '../components/TitleBlock';

interface CapacityMeterCellProps {
  gauge: HostResourceGauge;
  /** Figma rules the two cells apart rather than boxing each one. */
  hasLeadingRule: boolean;
}

/** One capacity reading: label, bar, and the free-space line under it. */
function CapacityMeterCell({ gauge, hasLeadingRule }: CapacityMeterCellProps) {
  // The bar width is a class, not a style attribute: the renderer's CSP forbids
  // inline styles, so index.css emits `w-[0%]`-`w-[100%]` for this to pick from.
  const barWidthClass = `w-[${Math.round(gauge.usedFraction * 100)}%]`;

  return (
    <div
      className={`flex min-w-0 flex-1 flex-col gap-1.5 px-4 py-3 ${hasLeadingRule ? 'border-l border-separator-hairline' : ''}`}
      data-testid={`capacity-meter-${gauge.id}`}
    >
      <div className="flex w-full items-start justify-between text-[10px] leading-[12px]">
        <span className="text-text-secondary">{gauge.label}</span>
        <span className="font-bold text-text-primary">{gauge.percentText}</span>
      </div>

      <div className="h-[4px] w-full overflow-hidden rounded-full bg-meter-track">
        <div className={`h-full rounded-full bg-meter-fill ${barWidthClass}`} />
      </div>

      <span className="text-[8px] leading-[10px] text-text-secondary">{gauge.detailText}</span>
    </div>
  );
}

/**
 * "This Mac" card: the machine on top, its live capacity meters below. The two
 * halves are separate boxes so only the outer corners round (Figma 225:2189
 * and 227:3168).
 *
 * The meters poll the main process while this page is mounted. Until the first
 * reading lands — and if every probe fails — the machine row renders alone and
 * closes its own corners, rather than showing empty bars.
 */
function HostMachineCard() {
  const snapshot = useHostSnapshot();
  const gauges = snapshot?.gauges ?? [];
  const hasGauges = gauges.length > 0;

  return (
    <section className="flex w-full flex-col" data-testid="host-machine-card">
      <div
        className={`flex h-[66px] w-full items-center justify-between overflow-hidden border border-surface-card-border bg-surface-card p-4 ${hasGauges ? 'rounded-t-[12px]' : 'rounded-[12px]'}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <IconTile src={`${ICON_BASE_PATH}/main-mac-laptop.svg`} />
          <TitleBlock
            title={HOST_MACHINE.name}
            subtitle={snapshot?.machine.detailText ?? HOST_MACHINE.placeholderDetail}
          />
        </div>

        <span className="flex min-h-[19.114px] shrink-0 items-center rounded-full bg-status-idle-bg px-2 py-1">
          <span className="text-[8.31px] leading-[10px] font-bold tracking-[0.0997px] text-status-idle-text">
            {HOST_MACHINE.status}
          </span>
        </span>
      </div>

      {hasGauges && (
        <div className="flex w-full items-start justify-center rounded-b-[12px] border-r border-b border-l border-surface-card-border">
          {gauges.map((gauge, index) => (
            <CapacityMeterCell key={gauge.id} gauge={gauge} hasLeadingRule={index > 0} />
          ))}
        </div>
      )}
    </section>
  );
}

interface CatalogModelRowProps {
  model: CatalogModel;
  isFirst: boolean;
  isLast: boolean;
  /** True while this row's own action is still running in the main process. */
  isBusy: boolean;
  onAction: (modelId: string, kind: CatalogActionKind) => void;
}

/**
 * One catalog entry. The list is ruled between rows rather than around them,
 * so the first row drops its top padding and the last its bottom padding.
 */
function CatalogModelRow({ model, isFirst, isLast, isBusy, onAction }: CatalogModelRowProps) {
  const spacingClasses = [
    isFirst ? '' : 'border-t border-separator-hairline pt-3',
    isLast ? '' : 'pb-3'
  ].join(' ');
  const { action } = model;

  return (
    <div
      className={`flex w-full items-center justify-between ${spacingClasses}`}
      data-testid={`catalog-model-${model.id}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[10px] leading-[12px]">
        <span className="truncate font-bold text-text-primary">{model.name}</span>
        <span className="truncate text-text-secondary">{model.detail}</span>
      </div>

      {action && (
        <PushButton
          variant={action.variant}
          onClick={() => onAction(model.id, action.kind)}
          disabled={isBusy}
          testId={`catalog-${action.kind}-${model.id}`}
        >
          {action.label}
        </PushButton>
      )}
    </div>
  );
}

interface CatalogNoticeProps {
  message: string;
  /** Offered only when re-fetching the catalog is what the message calls for. */
  onRetry?: () => void;
}

/** Stands in for the list while it is empty, loading, or unreachable. */
function CatalogNotice({ message, onRetry }: CatalogNoticeProps) {
  return (
    <div
      className="flex w-full items-center justify-between gap-2 py-2 text-[10px] leading-[12px] text-text-secondary"
      data-testid="catalog-notice"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <PushButton variant="tinted" onClick={onRetry} testId="catalog-retry">
          Try again
        </PushButton>
      )}
    </div>
  );
}

/** "Recommended for this Mac": provider filter and the downloadable models. */
function CatalogCard() {
  const catalog = useLocalModelCatalog();
  const models = catalog.scan?.models ?? [];
  // The "all" entry is the filter's own, so it leads the providers the scan found.
  const providerOptions: PopUpOption[] = [
    { value: ALL_PROVIDERS, label: PROVIDER_FILTER_LABEL },
    ...(catalog.scan?.providers ?? []).map((provider) => ({ value: provider, label: provider }))
  ];
  const selectedLabel =
    providerOptions.find((option) => option.value === catalog.provider)?.label ?? PROVIDER_FILTER_LABEL;

  return (
    <section
      // `min-h-0` with the scrolling list below keeps a catalog of any length
      // inside the page instead of pushing the window's content out of view.
      className="flex min-h-0 w-full flex-1 flex-col gap-4 overflow-hidden rounded-[12px] border border-surface-panel-border bg-white p-4"
      data-testid="catalog-card"
    >
      <div className="flex w-full items-center justify-between">
        <TitleBlock
          title={CATALOG_HEADING}
          subtitle={describeCatalogCapability(catalog.scan?.capability ?? null)}
          as="h2"
        />
        <PopUpButton
          label={selectedLabel}
          options={providerOptions}
          value={catalog.provider}
          onChange={catalog.selectProvider}
          testId="provider-filter"
        />
      </div>

      <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
        {/* A failed scan still shows whatever rows survived from the last one. */}
        {catalog.error && <CatalogNotice message={catalog.error} onRetry={catalog.refresh} />}

        {models.length === 0 && !catalog.error && (
          <CatalogNotice
            message={catalog.isLoading ? CATALOG_LOADING_MESSAGE : CATALOG_EMPTY_MESSAGE}
          />
        )}

        {models.map((model, index) => (
          <CatalogModelRow
            key={model.id}
            model={describeCatalogModel(model)}
            isFirst={index === 0}
            isLast={index === models.length - 1}
            isBusy={catalog.busyModelId === model.id}
            onAction={catalog.runAction}
          />
        ))}
      </div>
    </section>
  );
}

interface AddModelPageProps {
  /** Returns to the Tokiie page; also drives the header's back button. */
  onBack: () => void;
}

/** The panel behind the Tokiie page's "Add model" button. */
export function AddModelPage({ onBack }: AddModelPageProps) {
  return (
    <PageShell
      title="Add Model"
      subtitle="Download a compatible local model for this Mac."
      testId="add-model"
      onBack={onBack}
    >
      <HostMachineCard />
      <CatalogCard />
    </PageShell>
  );
}
