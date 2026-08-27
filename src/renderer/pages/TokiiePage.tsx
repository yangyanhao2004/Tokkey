import { useState } from 'react';
import {
  CONNECTED_DEVICE,
  ICON_BASE_PATH,
  INSTALLED_MODELS,
  LOCAL_MODELS_FOOTNOTE,
  formatModelCount,
  type InstalledModel
} from './tokiieContent';
import { AddModelPage } from './AddModelPage';
import { IconTile } from '../components/IconTile';
import { PageShell } from '../components/PageShell';
import { PushButton } from '../components/PushButton';
import { TitleBlock } from '../components/TitleBlock';

/** "Tokii CDEF is connected" summary card. */
function DeviceCard() {
  return (
    <section
      className="flex w-full items-center justify-between overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card p-4"
      data-testid="device-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconTile src={`${ICON_BASE_PATH}/main-device-thumb.png`} desaturate />
        <TitleBlock title={CONNECTED_DEVICE.name} subtitle={CONNECTED_DEVICE.detail} />
      </div>

      <span className="flex min-h-[19.114px] shrink-0 items-center gap-1 rounded-full bg-status-ok-bg px-2 py-1">
        <img
          className="block size-[13.296px] max-w-none"
          src={`${ICON_BASE_PATH}/main-badge-connected.svg`}
          alt=""
        />
        <span className="text-[8.31px] leading-[10px] font-bold tracking-[0.0997px] text-status-ok-text">
          {CONNECTED_DEVICE.status}
        </span>
      </span>
    </section>
  );
}

interface ModelRowProps {
  model: InstalledModel;
}

/** One installed model with its start/remove actions. */
function ModelRow({ model }: ModelRowProps) {
  return (
    <div
      className="flex w-full items-center justify-between border-t border-separator p-4"
      data-testid={`model-row-${model.id}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconTile src={`${ICON_BASE_PATH}/main-model-cube.svg`} />
        <TitleBlock title={model.name} subtitle={model.detail} />
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2">
        <PushButton testId={`model-start-${model.id}`}>Start</PushButton>
        <PushButton variant="plain" testId={`model-remove-${model.id}`}>
          Remove
        </PushButton>
      </div>
    </div>
  );
}

interface LocalModelsCardProps {
  /** Opens the Add Model panel. */
  onAddModel: () => void;
}

/** "Local Models" card: heading, installed list, and the single-runtime note. */
function LocalModelsCard({ onAddModel }: LocalModelsCardProps) {
  return (
    <section
      className="flex w-full flex-col items-center overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card pb-3"
      data-testid="local-models-card"
    >
      <div className="flex w-full items-center justify-between px-4 py-3">
        <TitleBlock
          title="Local Models"
          subtitle="Download, start, and manage models stored on this Mac."
          as="h2"
        />
        <PushButton onClick={onAddModel} testId="add-model">
          Add model
        </PushButton>
      </div>

      <div className="flex w-full flex-col">
        <div className="flex w-full items-center justify-between px-4 py-2 text-[10px] leading-[12px]">
          <span className="font-bold text-text-primary">Installed</span>
          <span className="tracking-[0.0997px] text-text-secondary">
            {formatModelCount(INSTALLED_MODELS.length)}
          </span>
        </div>
        {INSTALLED_MODELS.map((model) => (
          <ModelRow key={model.id} model={model} />
        ))}
      </div>

      <div className="flex w-full flex-col px-4">
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
 * The page behind the "Tokiie" nav row: device status and local models.
 * "Add model" swaps the whole page for the Add Model panel, which returns here
 * through the header's Back button.
 */
export function TokiiePage() {
  const [isAddingModel, setIsAddingModel] = useState(false);

  if (isAddingModel) {
    return <AddModelPage onBack={() => setIsAddingModel(false)} />;
  }

  return (
    <PageShell title="Tokiie" subtitle="Connect Tokii and manage your local models." testId="tokiie">
      <DeviceCard />
      <LocalModelsCard onAddModel={() => setIsAddingModel(true)} />
    </PageShell>
  );
}
