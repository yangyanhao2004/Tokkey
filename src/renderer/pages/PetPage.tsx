import { useState } from 'react';
import { Apple, CircleUserRound, Search, SlidersHorizontal, Wifi } from 'lucide-react';
import { PageShell } from '../components/PageShell';
import { SegmentedControl } from '../components/SegmentedControl';
import { Switch } from '../components/Switch';
import { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

const PET_ASSET_BASE_PATH = './assets/pet';

type PetSettingValue = 'small' | 'mid' | 'large';

const PET_SETTING_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'mid', label: 'Mid' },
  { value: 'large', label: 'Large' }
] as const;

interface PetSettingRowProps {
  title: string;
  description: string;
  value: PetSettingValue;
  onChange: (value: PetSettingValue) => void;
  position: 'first' | 'middle' | 'last';
  testId: string;
}

/** One compact setting row from the enabled Pet panel. */
function PetSettingRow({
  title,
  description,
  value,
  onChange,
  position,
  testId
}: PetSettingRowProps) {
  const spacingClasses = {
    first: 'pb-3',
    middle: 'border-t border-separator-hairline py-3',
    last: 'border-t border-separator-hairline pt-3'
  }[position];

  return (
    <div className={`flex w-full items-center justify-between gap-4 ${spacingClasses}`}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[12px] leading-[14px] font-bold text-label-strong">
          {title}
        </span>
        <span className="truncate text-[10px] leading-[12px] text-label-eyebrow">
          {description}
        </span>
      </div>

      <SegmentedControl
        options={PET_SETTING_OPTIONS}
        value={value}
        onChange={onChange}
        label={title}
        testId={testId}
        widthClassName="w-[170px]"
        surfaceClassName="bg-control-recessed"
      />
    </div>
  );
}

interface PetToggleCardProps {
  isPetVisible: boolean;
  onChange: (isVisible: boolean) => void;
}

/** The setting shared by the Figma off and on frames. */
function PetToggleCard({ isPetVisible, onChange }: PetToggleCardProps) {
  return (
    <section
      className="flex w-full shrink-0 items-center justify-between gap-4 overflow-hidden rounded-[12px] border border-surface-panel-border bg-white p-4"
      data-testid="pet-toggle-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-pet-icon-tile">
          <img
            className="block size-[18px] max-w-none"
            src={`${ICON_BASE_PATH}/pet-show.svg`}
            alt=""
          />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-[12px] leading-[14px] font-bold text-label-strong">
            Show Pet
          </h2>
          <span className="truncate text-[10px] leading-[12px] text-label-eyebrow">
            Show or hide the desktop pet.
          </span>
        </div>
      </div>

      <Switch
        checked={isPetVisible}
        onChange={onChange}
        label="Show Pet"
        testId="pet-toggle"
      />
    </section>
  );
}

const DESKTOP_MENU_ITEMS = ['File', 'Edit', 'View', 'Go', 'Window', 'Help'] as const;

/** The clipped macOS desktop from the enabled-state Figma frame. */
function PetDesktopPreview() {
  return (
    <div
      className="relative h-[73.472px] w-full max-w-[560px] shrink-0 overflow-hidden rounded-[7.168px] bg-white"
      aria-label="Pet display preview"
      role="img"
      data-testid="pet-preview-canvas"
    >
      <span className="pet-desktop-wallpaper absolute top-[-0.583px] left-0 h-[370.081px] w-[559.787px] bg-white" />

      <div
        className="absolute top-[16.327px] left-[465.323px] size-[27.989px]"
        data-testid="pet-preview-character"
      >
        <img
          className="pointer-events-none absolute top-[-3.2px] left-[-12.395px] block size-[48.384px] max-w-none object-cover"
          src={`${PET_ASSET_BASE_PATH}/pet-idle-yawn.png`}
          alt=""
        />
      </div>

      <div className="absolute top-[2.688px] left-[0.448px] flex w-[557.312px] max-w-[calc(100%-0.896px)] items-center justify-between px-[3.749px] py-[1.874px] text-[4.87px] leading-[5.998px] font-semibold text-black">
        <span className="pet-menu-bar-effect pointer-events-none absolute inset-x-0 top-0 h-[26.99px]" />

        <div className="relative flex items-center">
          <span className="flex h-[8.997px] w-[12.37px] shrink-0 items-center justify-center rounded-[4px]">
            <Apple className="size-[7px] fill-black" strokeWidth={2} aria-hidden="true" />
          </span>
          <span className="rounded-[4px] px-[4.123px] py-[1.499px] font-bold">Finder</span>
          {DESKTOP_MENU_ITEMS.map((item) => (
            <span key={item} className="rounded-[4px] px-[4.123px] py-[1.499px]">
              {item}
            </span>
          ))}
        </div>

        <div className="relative flex items-center justify-end">
          <span className="rounded-[4px] px-[4.123px] py-[1.499px]">
            <Wifi className="size-[5px]" strokeWidth={2.25} aria-hidden="true" />
          </span>
          <span className="rounded-[4px] px-[4.123px] py-[1.499px]">
            <Search className="size-[5px]" strokeWidth={2.25} aria-hidden="true" />
          </span>
          <span className="rounded-[4px] px-[4.123px] py-[1.499px]">
            <CircleUserRound className="size-[5px]" strokeWidth={2.25} aria-hidden="true" />
          </span>
          <span className="rounded-[4px] px-[4.123px] py-[1.499px]">
            <SlidersHorizontal className="size-[5px]" strokeWidth={2.25} aria-hidden="true" />
          </span>
          <span className="whitespace-nowrap rounded-[4px] px-[4.123px] py-[1.499px]">
            Mon Jun 10&nbsp; 9:41 AM
          </span>
        </div>
      </div>
    </div>
  );
}

/** The preview area visible only while the desktop companion is enabled. */
function PetPreview() {
  return (
    <section
      className="flex w-full shrink-0 flex-col items-center justify-center gap-4 overflow-hidden rounded-[12px] border border-surface-panel-border bg-white p-4"
      data-testid="pet-preview"
    >
      <PetDesktopPreview />
      <span className="text-[10px] leading-[12px] font-semibold text-label-eyebrow">
        Pet Display
      </span>
    </section>
  );
}

/** Size, speed, and range controls from the enabled Pet frame. */
function PetSettings() {
  const [size, setSize] = useState<PetSettingValue>('mid');
  const [speed, setSpeed] = useState<PetSettingValue>('mid');
  const [range, setRange] = useState<PetSettingValue>('small');

  return (
    <section
      className="flex w-full shrink-0 flex-col overflow-hidden rounded-[12px] border border-surface-panel-border bg-white p-4"
      aria-label="Pet settings"
      data-testid="pet-settings"
    >
      <PetSettingRow
        title="Size"
        description="Choose the pet scale."
        value={size}
        onChange={setSize}
        position="first"
        testId="pet-size"
      />
      <PetSettingRow
        title="Move speed"
        description="Choose how fast it moves."
        value={speed}
        onChange={setSpeed}
        position="middle"
        testId="pet-speed"
      />
      <PetSettingRow
        title="Move range"
        description="Choose its activity range."
        value={range}
        onChange={setRange}
        position="last"
        testId="pet-range"
      />
    </section>
  );
}

/** Pet settings page represented by Figma's paired off/on frames. */
export function PetPage() {
  const [isPetVisible, setIsPetVisible] = useState(false);

  return (
    <PageShell
      title="Pet"
      subtitle="A quiet desktop companion for runtime and connection status."
      testId="pet"
    >
      <PetToggleCard isPetVisible={isPetVisible} onChange={setIsPetVisible} />
      {isPetVisible ? (
        <>
          <PetPreview />
          <PetSettings />
        </>
      ) : null}
    </PageShell>
  );
}
