import { useEffect } from 'react';
import {
  ICON_BASE_PATH,
  INSTALLED_EMPTY_MESSAGE,
  INSTALLED_LOADING_MESSAGE,
  LOCAL_MODELS_FOOTNOTE,
  RECOMMENDED_LOCAL_MODEL,
  describeInstalledModel,
  describeRecommendedButtons,
  describeRecommendedNote,
  findModelActionError,
  findRecommendedInstall,
  formatModelCount,
  type InstalledModel,
  type RecommendedModelButton
} from './tokkeyContent';
import { useInstalledModels } from '../hooks/useInstalledModels';
import { useRecommendedModel } from '../hooks/useRecommendedModel';
import { DownloadProgressButton } from '../components/DownloadProgressButton';
import { IconTile } from '../components/IconTile';
import { useNavigation } from '../components/NavigationProvider';
import { PageShell } from '../components/PageShell';
import { PushButton } from '../components/PushButton';
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
    ? `Tokii${suffix ? ` ${suffix}` : ''} is connected`
    : 'No Tokii connected';
  const detail = isConnected
    ? 'Connected via USB-C · local runtime available to supported clients'
    : 'Connect Tokii via USB-C to start a local model';

  return (
    <section
      className="flex w-full items-center justify-between overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card p-4"
      data-testid="device-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconTile src={`${ICON_BASE_PATH}/main-device-thumb.png`} desaturate />
        <TitleBlock title={name} subtitle={detail} />
      </div>

      <span className={`flex min-h-[19.114px] shrink-0 items-center gap-1 rounded-full px-2 py-1 ${
        isConnected ? 'bg-status-ok-bg' : 'bg-fill-tile'
      }`}>
        {isConnected && (
          <img
            className="block size-[13.296px] max-w-none"
            src={`${ICON_BASE_PATH}/main-badge-connected.svg`}
            alt=""
          />
        )}
        <span className={`text-[8.31px] leading-[10px] font-bold tracking-[0.0997px] ${
          isConnected ? 'text-status-ok-text' : 'text-text-secondary'
        }`}>
          {isConnected ? 'Connected' : 'Not connected'}
        </span>
      </span>
    </section>
  );
}

interface RecommendedModelCardProps {
  installed: InstalledModels;
}

/**
 * The recommended model, offered above the installed list (Figma 531:613).
 *
 * It carries the same lifecycle the rows below do, and through the same paths:
 * downloading is the catalog's business, while starting and removing act on the
 * copy on disk and so go through the installed list, by the id that list knows
 * the model under. The two are kept in step in both directions — this card asks
 * the list to reload after every download it takes on, and re-scans whenever the
 * list reports this model installed, removed, or running.
 */
function RecommendedModelCard({ installed }: RecommendedModelCardProps) {
  const recommended = useRecommendedModel(installed.refresh);
  const install = findRecommendedInstall(installed.models, recommended.row);
  const isRunning = install !== null && installed.runningModelId === install.id;

  // Only the two facts the list holds that this card's own scan cannot see, so
  // an action taken on the same model below reaches the badge without the two
  // refreshing each other in a loop.
  const installId = install?.id ?? null;

  // Start and remove run through the installed list, so a failure of either
  // comes back from there — under the id that list knows this model under.
  const note = describeRecommendedNote(
    recommended.row,
    recommended.error,
    findModelActionError(installed.actionError, installId)
  );
  const { refresh } = recommended;

  useEffect(refresh, [installId, isRunning, refresh]);

  const isBusy = recommended.isBusy || (installId !== null && installed.busyModelId === installId);

  // Downloads are the catalog's; anything acting on the bytes already on disk
  // belongs to the installed list, which owns their id.
  const press = (button: RecommendedModelButton) => {
    if (button.kind === 'start' && install) return installed.start(install.id);
    if (button.kind === 'remove' && install) return installed.remove(install.id);
    if (button.kind === 'download' || button.kind === 'cancel') {
      recommended.runAction(button.kind);
    }
  };

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
        {describeRecommendedButtons({ install, isRunning, row: recommended.row }).map(renderButton)}
      </div>
    </section>
  );
}

interface ModelRowProps {
  model: InstalledModel;
  installed: InstalledModels;
  onStart: (modelId: string) => void;
  onRemove: (modelId: string) => void;
}

/** One installed model with its start/remove actions. */
function ModelRow({ model, installed, onStart, onRemove }: ModelRowProps) {
  const isBusy = installed.busyModelId === model.id;
  const isRunning = installed.runningModelId === model.id;
  const actionError = findModelActionError(installed.actionError, model.id);

  return (
    <div
      className="flex w-full flex-col border-t border-separator p-4"
      data-testid={`model-row-${model.id}`}
    >
      <div className="flex w-full items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <IconTile src={`${ICON_BASE_PATH}/main-model-cube.svg`} />
          <TitleBlock title={model.name} subtitle={model.detail} />
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <PushButton
            onClick={() => onStart(model.id)}
            disabled={isBusy || isRunning}
            testId={`model-start-${model.id}`}
          >
            {isRunning ? 'Running' : 'Start'}
          </PushButton>
          <PushButton
            variant="plain"
            onClick={() => onRemove(model.id)}
            disabled={isBusy}
            testId={`model-remove-${model.id}`}
          >
            Remove
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

interface InstalledNoticeProps {
  message: string;
}

/** Stands in for the list while nothing is installed or the scan failed. */
function InstalledNotice({ message }: InstalledNoticeProps) {
  return (
    <p
      className="w-full border-t border-separator px-4 py-3 text-[10px] leading-[12px] text-text-secondary"
      data-testid="installed-notice"
    >
      {message}
    </p>
  );
}

interface LocalModelsCardProps {
  /** Opens the Add Model panel. */
  onAddModel: () => void;
  installed: InstalledModels;
}

/** "Local Models" card: heading, installed list, and the single-runtime note. */
function LocalModelsCard({ onAddModel, installed }: LocalModelsCardProps) {
  const models = installed.models ?? [];
  const emptyMessage = installed.isLoading ? INSTALLED_LOADING_MESSAGE : INSTALLED_EMPTY_MESSAGE;

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

        {/* A failed scan still shows whatever rows survived from the last one. */}
        {installed.error && <InstalledNotice message={installed.error} />}

        {models.length === 0 && !installed.error && <InstalledNotice message={emptyMessage} />}

        {models.map((model) => (
          <ModelRow
            key={model.id}
            model={describeInstalledModel(model)}
            installed={installed}
            onStart={installed.start}
            onRemove={installed.remove}
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

  return (
    <PageShell title="Tokkey" subtitle="Connect Tokii and manage your local models." testId="tokkey">
      <DeviceCard runtime={installed.runtime} />
      <RecommendedModelCard installed={installed} />
      <LocalModelsCard installed={installed} onAddModel={() => navigate('add-model')} />
    </PageShell>
  );
}
