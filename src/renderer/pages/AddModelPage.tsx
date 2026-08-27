import type { HostResourceGauge } from '../../shared/types';
import {
  CATALOG_HEADING,
  CATALOG_MODELS,
  CATALOG_SUBHEADING,
  HOST_MACHINE,
  ICON_BASE_PATH,
  PROVIDER_FILTER_LABEL,
  type CatalogModel
} from './addModelContent';
import { useHostSnapshot } from '../hooks/useHostSnapshot';
import { IconTile } from '../components/IconTile';
import { PageShell } from '../components/PageShell';
import { PopUpButton } from '../components/PopUpButton';
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
}

/**
 * One catalog entry. The list is ruled between rows rather than around them,
 * so the first row drops its top padding and the last its bottom padding.
 */
function CatalogModelRow({ model, isFirst, isLast }: CatalogModelRowProps) {
  const spacingClasses = [
    isFirst ? '' : 'border-t border-separator-hairline pt-3',
    isLast ? '' : 'pb-3'
  ].join(' ');

  return (
    <div
      className={`flex w-full items-center justify-between ${spacingClasses}`}
      data-testid={`catalog-model-${model.id}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[10px] leading-[12px]">
        <span className="truncate font-bold text-text-primary">{model.name}</span>
        <span className="truncate text-text-secondary">{model.detail}</span>
      </div>

      {model.isDownloaded ? (
        <PushButton variant="tinted" testId={`catalog-remove-${model.id}`}>
          Remove
        </PushButton>
      ) : (
        <PushButton testId={`catalog-download-${model.id}`}>Download</PushButton>
      )}
    </div>
  );
}

/** "Recommended for this Mac": provider filter and the downloadable models. */
function CatalogCard() {
  return (
    <section
      className="flex w-full flex-col gap-4 overflow-hidden rounded-[12px] border border-surface-panel-border bg-white p-4"
      data-testid="catalog-card"
    >
      <div className="flex w-full items-center justify-between">
        <TitleBlock title={CATALOG_HEADING} subtitle={CATALOG_SUBHEADING} as="h2" />
        <PopUpButton label={PROVIDER_FILTER_LABEL} testId="provider-filter" />
      </div>

      <div className="flex w-full flex-col">
        {CATALOG_MODELS.map((model, index) => (
          <CatalogModelRow
            key={model.id}
            model={model}
            isFirst={index === 0}
            isLast={index === CATALOG_MODELS.length - 1}
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
