import { useEffect, useMemo } from 'react';
import {
  ICON_BASE_PATH,
  LOCAL_MODELS_FOOTNOTE,
  RECOMMENDED_LOCAL_MODEL,
  describeInstalledModel,
  describeModelRemoveButton,
  describeModelRuntimeButton,
  describeRecommendedButtons,
  describeRecommendedNote,
  findModelActionError,
  findRecommendedInstall,
  formatModelCount,
  orderInstalledModels,
  type InstalledModel,
  type RecommendedModelButton
} from './tokkeyContent';
import { useInstalledModels } from '../hooks/useInstalledModels';
import { useRecommendedModel, type RecommendedModel } from '../hooks/useRecommendedModel';
import { DownloadProgressButton } from '../components/DownloadProgressButton';
import { IconTile } from '../components/IconTile';
import { useNavigation } from '../components/NavigationProvider';
import { PageShell } from '../components/PageShell';
import { PushButton } from '../components/PushButton';
import { StatusPill } from '../components/StatusPill';
import { TitleBlock } from '../components/TitleBlock';
import type { InstalledModels } from '../hooks/useInstalledModels';

interface DeviceCardProps {
  runtime: InstalledModels['runtime'];
}

/** Live USB Dongle summary, including the serial suffix used by Token Hub. */
function DeviceCard({ runtime }: DeviceCardProps) {
  const suffix = runtime.device?.serialNumber?.slice(-4).toUpperCase();
  const isConnected = runtime.device !== null;
  const name = isConnected
    ? `Tokkey${suffix ? ` ${suffix}` : ''} is connected`
    : 'No Tokkey connected';
  const detail = isConnected
    ? 'Connected via USB-C · local runtime available to supported clients'
    : 'Connect Tokkey via USB-C to start a local model';

  return (
    <section
      className="flex w-full items-center justify-between overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card p-4"
      data-testid="device-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconTile src={`${ICON_BASE_PATH}/main-device-thumb.png`} desaturate />
        <TitleBlock title={name} subtitle={detail} />
      </div>

      <StatusPill
        label={isConnected ? 'Connected' : 'Not connected'}
        tone={isConnected ? 'ok' : 'muted'}
        iconSrc={isConnected ? `${ICON_BASE_PATH}/main-badge-connected.svg` : undefined}
      />
    </section>
  );
}

interface RecommendedModelCardProps {
  recommended: RecommendedModel;
}

/**
 * The recommended model while it is not yet on disk (Figma 531:613).
 *
 * Downloading is all this card does. The moment the bytes land, the model joins
 * the installed list below — marked as recommended — and every lifecycle action
 * belongs to that row, so one model is never offered in two places at once.
 */
function RecommendedModelCard({ recommended }: RecommendedModelCardProps) {
  const note = describeRecommendedNote(recommended.row, recommended.error);
  const isBusy = recommended.isBusy;

  const press = (button: RecommendedModelButton) => recommended.runAction(button.kind);

  const renderButton = (button: RecommendedModelButton) => {
    const isDisabled = button.disabled || isBusy;
    const testId = `recommended-model-${button.kind}`;

    if (button.variant === 'progress') {
      return (
        <DownloadProgressButton
          key={button.kind}
          progress={recommended.row?.progress ?? null}
          onClick={() => press(button)}
          disabled={isDisabled}
          testId={testId}
        >
          {button.label}
        </DownloadProgressButton>
      );
    }

    return (
      <PushButton
        key={button.kind}
        variant={button.variant}
        onClick={() => press(button)}
        disabled={isDisabled}
        testId={testId}
      >
        {button.label}
      </PushButton>
    );
  };

  return (
    <section
      className="flex w-full shrink-0 items-center justify-between overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card p-4"
      data-testid="recommended-model-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="relative flex size-8 shrink-0 items-center justify-center rounded-[8.421px] bg-fill-tile">
          <span className="text-[12px] leading-[14px] font-bold text-text-primary">
            {RECOMMENDED_LOCAL_MODEL.initials}
          </span>
          {/* Sits proud of the tile's bottom-right corner, as in the design. */}
          <img
            className="absolute top-[19px] left-[20px] block size-[11px] max-w-none"
            src={`${ICON_BASE_PATH}/main-badge-recommended.svg`}
            alt=""
          />
        </span>

        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[10px] leading-[12px] font-bold tracking-[0.0548px] text-label-eyebrow">
            {RECOMMENDED_LOCAL_MODEL.eyebrow}
          </span>
          {/* The catalog's own name once it is known, so a rename reaches here. */}
          <span className="truncate text-[12px] leading-[14px] font-bold text-text-primary">
            {recommended.row?.name ?? RECOMMENDED_LOCAL_MODEL.name}
          </span>
          {note && (
            <span
              // A failure is worth its full width; the progress line, which the
              // buttons repeat anyway, still gives way to them.
              className={`text-[10px] leading-[12px] ${
                note.tone === 'error'
                  ? 'break-words text-status-error-text'
                  : 'truncate text-text-secondary'
              }`}
              data-testid="recommended-model-note"
            >
              {note.text}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2">
        {describeRecommendedButtons(recommended.row).map(renderButton)}
      </div>
    </section>
  );
}

interface ModelRowProps {
  model: InstalledModel;
  installed: InstalledModels;
}

/** One installed model with its start/stop and remove actions. */
function ModelRow({ model, installed }: ModelRowProps) {
  const actionError = findModelActionError(installed.actionError, model.id);
  // One button for the whole server lifecycle: it names what the runtime is
  // doing, and pressing it asks for the opposite of what the runtime reports.
  // Remove is the step after it, so it waits until the server is down.
  const lifecycleState = {
    runtime: installed.runtime,
    busyModelId: installed.busyModelId,
    busyAction: installed.busyAction
  };
  const lifecycle = describeModelRuntimeButton(model.id, lifecycleState);
  const removal = describeModelRemoveButton(model.id, lifecycleState);

  return (
    <div
      className="flex w-full flex-col border-t border-separator p-4"
      data-testid={`model-row-${model.id}`}
    >
      <div className="flex w-full items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex shrink-0">
            <IconTile src={`${ICON_BASE_PATH}/main-model-cube.svg`} />
            {/* The badge's own mark, in the badge's own place on the tile. */}
            {model.isRecommended && (
              <img
                className="absolute top-[19px] left-[20px] block size-[11px] max-w-none"
                src={`${ICON_BASE_PATH}/main-badge-recommended.svg`}
                alt="Recommended"
                data-testid={`model-recommended-${model.id}`}
              />
            )}
          </span>
          <TitleBlock title={model.name} subtitle={model.detail} />
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <PushButton
            onClick={() => (lifecycle.kind === 'stop' ? installed.stop(model.id) : installed.start(model.id))}
            disabled={lifecycle.disabled}
            progress={lifecycle.progress}
            testId={`model-${lifecycle.kind}-${model.id}`}
          >
            {lifecycle.label}
          </PushButton>
          <PushButton
            variant="plain"
            onClick={() => installed.remove(model.id)}
            disabled={removal.disabled}
            testId={`model-remove-${model.id}`}
          >
            {removal.label}
          </PushButton>
        </div>
      </div>

      {/* Under the whole row rather than the title, since it answers a button. */}
      {actionError && (
        <p
          className="mt-2 w-full break-words text-[10px] leading-[12px] text-status-error-text"
          data-testid={`model-error-${model.id}`}
        >
          {actionError}
        </p>
      )}
    </div>
  );
}

interface LocalModelsCardProps {
  /** Opens the Add Model panel. */
  onAddModel: () => void;
  installed: InstalledModels;
  /** The row the recommended badge handed over, or `null` while it holds it. */
  recommendedModelId: string | null;
}

/** "Local Models" card: heading, installed list, and the single-runtime note. */
function LocalModelsCard({ onAddModel, installed, recommendedModelId }: LocalModelsCardProps) {
  const models = useMemo(
    () => orderInstalledModels(installed.models, recommendedModelId),
    [installed.models, recommendedModelId]
  );

  return (
    <section
      // `min-h-0` with the scrolling list below keeps any number of installed
      // models inside the page instead of pushing the footnote out of view.
      className="flex min-h-0 w-full flex-col items-center overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card pb-3"
      data-testid="local-models-card"
    >
      <div className="flex w-full shrink-0 items-center justify-between px-4 py-3">
        <TitleBlock
          title="Local Models"
          subtitle="Download, start, and manage models stored on this Mac."
          as="h2"
        />
        <PushButton onClick={onAddModel} testId="add-model">
          Add model
        </PushButton>
      </div>

      <div className="flex min-h-0 w-full flex-col overflow-y-auto">
        <div className="flex w-full shrink-0 items-center justify-between px-4 py-2 text-[10px] leading-[12px]">
          <span className="font-bold text-text-primary">Installed</span>
          <span className="tracking-[0.0997px] text-text-secondary">
            {formatModelCount(models.length)}
          </span>
        </div>

        {models.map((model) => (
          <ModelRow
            key={model.id}
            model={describeInstalledModel(model, model.id === recommendedModelId)}
            installed={installed}
          />
        ))}
      </div>

      <div className="flex w-full shrink-0 flex-col px-4">
        <p className="flex w-full items-start gap-1.5 rounded-[8px] bg-fill-tile p-2">
          <img
            className="block size-[12px] shrink-0 max-w-none"
            src={`${ICON_BASE_PATH}/main-info.svg`}
            alt=""
          />
          <span className="min-w-0 flex-1 truncate text-[10px] leading-[12px] text-text-secondary">
            {LOCAL_MODELS_FOOTNOTE}
          </span>
        </p>
      </div>
    </section>
  );
}

/**
 * The page behind the "Tokkey" nav row: device status and local models.
 * "Add model" navigates to the Add Model panel, which the header's Back button
 * returns from like any other move.
 */
export function TokkeyPage() {
  const { navigate } = useNavigation();
  const installed = useInstalledModels();
  const recommended = useRecommendedModel(installed.refresh);
  // The recommended model has one home at a time: the badge until its bytes are
  // on disk, then the row below, which is where it is started, stopped, and
  // removed. Removing it hands it back to the badge.
  const recommendedInstall = findRecommendedInstall(installed.models, recommended.row);
  const { refresh } = recommended;

  // The badge's own scan cannot see a model arriving in or leaving the list, so
  // the hand-over in either direction is what re-reads the catalog row.
  useEffect(refresh, [recommendedInstall?.id, refresh]);

  return (
    <PageShell title="Tokkey" subtitle="Connect Tokkey and manage your local models." testId="tokkey">
      <DeviceCard runtime={installed.runtime} />
      {recommendedInstall === null && <RecommendedModelCard recommended={recommended} />}
      <LocalModelsCard
        installed={installed}
        recommendedModelId={recommendedInstall?.id ?? null}
        onAddModel={() => navigate('add-model')}
      />
    </PageShell>
  );
}
