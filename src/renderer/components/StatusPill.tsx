/**
 * The small rounded tag the design puts beside a title, e.g. "Connected" on the
 * device card and "Recommended" on the model it puts forward (Figma "Main"
 * 192:2507). One component so every tag keeps the same height, radius, and type.
 */

const TONE_CLASSES = {
  /** Green: the state the page wants to report as good. */
  ok: { background: 'bg-status-ok-bg', text: 'text-status-ok-text' },
  /** Grey: the same tag when that state does not hold. */
  muted: { background: 'bg-fill-tile', text: 'text-text-secondary' }
} as const;

interface StatusPillProps {
  label: string;
  tone?: keyof typeof TONE_CLASSES;
  /** Mark drawn before the label; omitted where the tone carries it alone. */
  iconSrc?: string;
  testId?: string;
}

export function StatusPill({ label, tone = 'ok', iconSrc, testId }: StatusPillProps) {
  const classes = TONE_CLASSES[tone];

  return (
    <span
      className={`flex min-h-[19.114px] shrink-0 items-center gap-1 rounded-full px-2 py-1 ${classes.background}`}
      data-testid={testId}
    >
      {iconSrc !== undefined && (
        <img className="block size-[13.296px] max-w-none" src={iconSrc} alt="" />
      )}
      <span className={`text-[8.31px] leading-[10px] font-bold tracking-[0.0997px] ${classes.text}`}>
        {label}
      </span>
    </span>
  );
}
