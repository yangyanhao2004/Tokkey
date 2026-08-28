import { useMemo, useState, type ReactNode } from 'react';
import {
  CLOUD_MODELS_EMPTY_MESSAGE,
  CLOUD_MODELS_SUBTITLE,
  CLOUD_MODELS_TITLE,
  CLOUD_MODELS_UNAVAILABLE_PREFIX,
  CLOUD_MODEL_CONNECT_FAILED_PREFIX,
  CLOUD_MODEL_SUMMARY,
  ICON_BASE_PATH,
  LOCAL_MODEL_SUMMARY,
  NO_CLOUD_MODEL_DETAIL,
  NO_CLOUD_MODEL_NAME,
  NO_LOCAL_MODEL_DETAIL,
  NO_LOCAL_MODEL_NAME,
  ROUTER_TOGGLE_DESCRIPTION,
  ROUTER_TOGGLE_TITLE,
  selectButtonLabel,
  toCloudModel,
  type CloudModel,
  type ModelSummary
} from './routerContent';
import { useCloudModelCards, type CloudModelCards } from '../hooks/useCloudModelCards';
import { PageShell } from '../components/PageShell';
import { PushButton } from '../components/PushButton';
import { Switch } from '../components/Switch';
import { TitleBlock } from '../components/TitleBlock';

/**
 * The 28px opaque tile that fronts every model row on this page, holding
 * either an icon or the model's initial. Figma sizes the tile and its glyph
 * independently, so callers set the glyph's own dimensions.
 */
function ModelTile({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-[28px] shrink-0 items-center justify-center rounded-[7.368px] bg-fill-tile-opaque">
      {children}
    </span>
  );
}

interface ModelRowProps {
  tile: ReactNode;
  name: string;
  detail: string;
}

/**
 * Name and detail beside a tile. Shared by the two summary cards and the cloud
 * model grid, which draw the same pair at the same 10px/9px scale - one notch
 * below `TitleBlock`'s card scale, so it keeps its own type here.
 */
function ModelRow({ tile, name, detail }: ModelRowProps) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {tile}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[10px] leading-[12px] font-bold text-label-strong">
          {name}
        </span>
        <span className="truncate text-[9px] leading-[11px] text-label-eyebrow">{detail}</span>
      </div>
    </div>
  );
}

interface RouterToggleCardProps {
  isRouterOn: boolean;
  onChange: (isRouterOn: boolean) => void;
}

/** The card carrying the whole feature's on/off switch. */
function RouterToggleCard({ isRouterOn, onChange }: RouterToggleCardProps) {
  return (
    <section
      className="flex w-full shrink-0 items-center justify-between gap-4 overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card p-4"
      data-testid="router-toggle-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* The sparkle asset carries its own recessed tile, unlike `IconTile`. */}
        <img
          className="block size-[32px] shrink-0 max-w-none"
          src={`${ICON_BASE_PATH}/router-sparkle.svg`}
          alt=""
        />
        <TitleBlock title={ROUTER_TOGGLE_TITLE} subtitle={ROUTER_TOGGLE_DESCRIPTION} as="h2" />
      </div>

      <Switch
        checked={isRouterOn}
        onChange={onChange}
        label={ROUTER_TOGGLE_TITLE}
        testId="router-toggle"
      />
    </section>
  );
}

interface ModelSummaryCardProps {
  summary: ModelSummary;
  name: string;
  detail: string;
  testId: string;
}

/** One half of the pair reporting which local and cloud model Router uses. */
function ModelSummaryCard({ summary, name, detail, testId }: ModelSummaryCardProps) {
  return (
    <section
      className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden rounded-[12px] border border-surface-panel-border bg-white p-4"
      data-testid={testId}
    >
      <div className="flex flex-col gap-1">
        <h2 className="truncate text-[10px] leading-[12px] font-bold uppercase text-label-eyebrow">
          {summary.eyebrow}
        </h2>
        <span className="truncate text-[10px] leading-[12px] text-label-eyebrow">
          {summary.hint}
        </span>
      </div>

      <div className="flex w-full items-center rounded-[8px] bg-vibrant-quaternary p-2">
        <ModelRow
          tile={
            <ModelTile>
              <img
                className={`block max-w-none object-contain ${summary.iconClass}`}
                src={`${ICON_BASE_PATH}/${summary.iconFile}`}
                alt=""
              />
            </ModelTile>
          }
          name={name}
          detail={detail}
        />
      </div>
    </section>
  );
}

interface CloudModelCardProps {
  model: CloudModel;
  isSelected: boolean;
  /** True while this card's connect is still running. */
  isConnecting: boolean;
  /** True while any card is connecting, which no second click may interrupt. */
  isBusy: boolean;
  onSelect: (modelId: string) => void;
}

/** One choice in the cloud model grid, with its own Select/Selected button. */
function CloudModelCard({
  model,
  isSelected,
  isConnecting,
  isBusy,
  onSelect
}: CloudModelCardProps) {
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-[8px] border p-3 ${
        isSelected
          ? 'border-selected-ink bg-vibrant-quaternary'
          : 'border-surface-panel-border bg-white'
      }`}
      data-testid={`cloud-model-${model.id}`}
    >
      <ModelRow
        tile={
          <ModelTile>
            <span className="text-[12px] leading-[14px] font-bold text-icon-primary">
              {model.initial}
            </span>
          </ModelTile>
        }
        name={model.name}
        detail={model.detail}
      />

      <PushButton
        variant={isSelected ? 'filled' : 'tinted'}
        onClick={() => onSelect(model.id)}
        // Only a running connect disables the row: the selected card keeps its
        // full-strength "Selected" button rather than fading out as done.
        disabled={isBusy}
        testId={`cloud-model-select-${model.id}`}
      >
        {selectButtonLabel(isSelected, isConnecting)}
      </PushButton>
    </div>
  );
}

interface CloudModelsCardProps {
  models: readonly CloudModel[];
  selectedModelId: string | null;
  connectingModelId: string | null;
  onSelect: (modelId: string) => void;
  /** Why the catalog or the last connect failed, if either did. */
  notice: string | null;
  /** Router off means nothing is routed to a cloud model, so the card greys out. */
  isEnabled: boolean;
}

/** "Cloud Models" card: heading plus the two-column grid of choices. */
function CloudModelsCard({
  models,
  selectedModelId,
  connectingModelId,
  onSelect,
  notice,
  isEnabled
}: CloudModelsCardProps) {
  return (
    <section
      // `min-h-0` with the scrolling grid below keeps any number of models
      // inside the page instead of pushing the card past its bottom edge.
      className={`flex min-h-0 w-full flex-col gap-3 overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card py-4 ${
        isEnabled ? '' : 'opacity-40'
      }`}
      // `inert` takes the whole card out of pointer and keyboard reach, so the
      // dimmed rows cannot be selected while Router is off. Dimming the card
      // once here also keeps the buttons from fading twice.
      inert={!isEnabled}
      data-testid="cloud-models-card"
    >
      <div className="shrink-0 px-4">
        <TitleBlock title={CLOUD_MODELS_TITLE} subtitle={CLOUD_MODELS_SUBTITLE} as="h2" />
      </div>

      {notice && (
        <p
          className="shrink-0 px-4 text-[10px] leading-[12px] text-text-secondary"
          data-testid="cloud-models-notice"
        >
          {notice}
        </p>
      )}

      <div className="grid min-h-0 grid-cols-2 gap-3 overflow-y-auto px-4">
        {models.map((model) => (
          <CloudModelCard
            key={model.id}
            model={model}
            isSelected={model.id === selectedModelId}
            isConnecting={model.id === connectingModelId}
            isBusy={connectingModelId !== null}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The one line the "Cloud Models" card shows above its grid: why a call failed,
 * or that this build offers nothing to select. Nothing is said while the
 * catalog is still on its way, so an empty grid never claims to be the answer.
 */
function buildCloudModelsNotice(cloudModels: CloudModelCards, modelCount: number): string | null {
  if (cloudModels.listError) {
    return `${CLOUD_MODELS_UNAVAILABLE_PREFIX}${cloudModels.listError}`;
  }
  if (cloudModels.connectError) {
    return `${CLOUD_MODEL_CONNECT_FAILED_PREFIX}${cloudModels.connectError}`;
  }
  if (cloudModels.cards === null) return null;
  return modelCount === 0 ? CLOUD_MODELS_EMPTY_MESSAGE : null;
}

/**
 * The page behind the "Router" nav row: the routing switch, what it currently
 * routes between, and the cloud model it falls back to for complex tasks.
 */
export function RouterPage() {
  const [isRouterOn, setIsRouterOn] = useState(true);
  const cloudModels = useCloudModelCards();
  const models = useMemo(() => (cloudModels.cards ?? []).map(toCloudModel), [cloudModels.cards]);
  // Selecting a card is what connects it, so the connected card is the
  // selection: nothing is reported above the grid that Router cannot reach.
  const selectedModel = models.find((model) => model.id === cloudModels.connectedCardId);
  const notice = buildCloudModelsNotice(cloudModels, models.length);

  return (
    <PageShell
      title="Router"
      subtitle="Simple tasks run on your Tokii. Hard ones go to a cloud model."
      testId="router"
    >
      <RouterToggleCard isRouterOn={isRouterOn} onChange={setIsRouterOn} />

      {/* The pair only reports what Router routes between, so it fades with it.
          The cards hold nothing focusable, so dimming alone is enough here. */}
      <div
        className={`flex w-full shrink-0 items-start justify-center gap-3 ${
          isRouterOn ? '' : 'opacity-40'
        }`}
      >
        <ModelSummaryCard
          summary={LOCAL_MODEL_SUMMARY}
          name={NO_LOCAL_MODEL_NAME}
          detail={NO_LOCAL_MODEL_DETAIL}
          testId="local-model-summary"
        />
        <ModelSummaryCard
          summary={CLOUD_MODEL_SUMMARY}
          name={selectedModel?.name ?? NO_CLOUD_MODEL_NAME}
          detail={selectedModel?.detail ?? NO_CLOUD_MODEL_DETAIL}
          testId="cloud-model-summary"
        />
      </div>

      <CloudModelsCard
        models={models}
        selectedModelId={selectedModel?.id ?? null}
        connectingModelId={cloudModels.connectingCardId}
        onSelect={cloudModels.connect}
        notice={notice}
        isEnabled={isRouterOn}
      />
    </PageShell>
  );
}
