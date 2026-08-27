import {
  CONNECTED_DEVICE,
  ICON_BASE_PATH,
  INSTALLED_MODELS,
  LOCAL_MODELS_FOOTNOTE,
  formatModelCount,
  type InstalledModel
} from '../mainContent';
import { PushButton } from './PushButton';

/**
 * The 32px recessed tile that fronts both the device row and each model row
 * (Figma "Overlay", nodes 192:2797 and 192:2828). Figma sizes the tile and its
 * glyph independently, so both dimensions stay explicit.
 */
interface IconTileProps {
  src: string;
  /** Luminosity blending is what greys the colour device photo in the design. */
  desaturate?: boolean;
}

function IconTile({ src, desaturate = false }: IconTileProps) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-[8.421px] bg-fill-tile">
      <img
        className={`block size-[16.842px] max-w-none object-contain ${desaturate ? 'mix-blend-luminosity' : ''}`}
        src={src}
        alt=""
      />
    </span>
  );
}

/** Back/forward pair plus the connection pill. */
function MainHeader() {
  return (
    <header
      className="flex shrink-0 items-center justify-between px-6 py-3 backdrop-blur-[11.634px]"
      data-testid="main-header"
    >
      <div className="flex h-[28px] items-center overflow-hidden rounded-full border border-black/8 bg-white/50 shadow-[0px_2.493px_9.972px_0px_rgba(0,0,0,0.05)]">
        <button
          type="button"
          className="flex h-[28px] w-[30px] items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary"
          aria-label="Go back"
          title="Back"
          data-testid="nav-back"
        >
          <img
            className="block size-[14.958px] max-w-none"
            src={`${ICON_BASE_PATH}/main-nav-back.svg`}
            alt=""
          />
        </button>
        <button
          type="button"
          className="flex h-[28px] w-[30px] items-center justify-center border-l-[0.831px] border-separator focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary"
          aria-label="Go forward"
          title="Forward"
          data-testid="nav-forward"
        >
          <img
            className="block size-[14.958px] max-w-none"
            src={`${ICON_BASE_PATH}/main-nav-forward.svg`}
            alt=""
          />
        </button>
      </div>

      <span
        className="flex items-center justify-center gap-1.5 rounded-full border-[0.829px] border-pill-border bg-pill-bg px-2 py-1"
        data-testid="connection-pill"
      >
        <span className="size-[6px] shrink-0 rounded-[3px] bg-status-live" />
        <span className="text-[11px] leading-[13px] font-bold text-pill-text">Tokiie connected</span>
      </span>
    </header>
  );
}

/** "Tokii CDEF is connected" summary card. */
function DeviceCard() {
  return (
    <section
      className="flex w-full items-center justify-between overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card p-4"
      data-testid="device-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconTile src={`${ICON_BASE_PATH}/main-device-thumb.png`} desaturate />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[12px] leading-[14px] font-bold text-text-primary">
            {CONNECTED_DEVICE.name}
          </span>
          <span className="truncate text-[10px] leading-[12px] tracking-[0.0548px] text-text-secondary">
            {CONNECTED_DEVICE.detail}
          </span>
        </div>
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
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[12px] leading-[14px] font-bold text-text-primary">
            {model.name}
          </span>
          {/* Figma states an 11.219px line-height but reports a 12px text box;
              12px is used so the row measures as designed. */}
          <span className="truncate text-[10px] leading-[12px] tracking-[0.0997px] text-text-secondary">
            {model.detail}
          </span>
        </div>
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

/** "Local Models" card: heading, installed list, and the single-runtime note. */
function LocalModelsCard() {
  return (
    <section
      className="flex w-full flex-col items-center overflow-hidden rounded-[12px] border border-surface-card-border bg-surface-card pb-3"
      data-testid="local-models-card"
    >
      <div className="flex w-full items-center justify-between px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[12px] leading-[14px] font-bold text-text-primary">Local Models</h2>
          <span className="truncate text-[10px] leading-[12px] text-text-secondary">
            Download, start, and manage models stored on this Mac.
          </span>
        </div>
        <PushButton testId="add-model">Add model</PushButton>
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

/** The right-hand content pane. */
export function MainPane() {
  return (
    <main
      // `overflow-hidden` is load-bearing: the header's backdrop-filter is
      // promoted to its own layer, which a bare border-radius does not clip, so
      // without it the blur paints square over the pane's rounded top corners.
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white"
      data-testid="main-pane"
    >
      <MainHeader />
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-[20px] leading-[24px] font-bold text-text-primary">Tokiie</h1>
          <span className="text-[12px] leading-[14px] text-text-secondary">
            Connect Tokii and manage your local models.
          </span>
        </div>
        <DeviceCard />
        <LocalModelsCard />
      </div>
    </main>
  );
}
