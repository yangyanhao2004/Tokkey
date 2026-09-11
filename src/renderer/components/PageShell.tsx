import type { ReactNode } from 'react';
import { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';
import { useNavigation } from './NavigationProvider';
import { TitleBlock } from './TitleBlock';

interface HistoryButtonProps {
  direction: 'back' | 'forward';
  onClick: () => void;
  /** True at that end of the history, where the button has nowhere to go. */
  disabled: boolean;
  /** The leading button carries no divider; the one beside it does. */
  isFirst?: boolean;
}

/** One half of the header's history control. */
function HistoryButton({ direction, onClick, disabled, isFirst = false }: HistoryButtonProps) {
  const label = direction === 'back' ? 'Go back' : 'Go forward';
  const divider = isFirst ? '' : 'border-l-[0.831px] border-separator';

  return (
    <button
      type="button"
      className={`flex h-[28px] w-[30px] items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary disabled:opacity-40 ${divider}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={direction === 'back' ? 'Back' : 'Forward'}
      data-testid={`nav-${direction}`}
    >
      <img
        className="block size-[14.958px] max-w-none"
        src={`${ICON_BASE_PATH}/main-nav-${direction}.svg`}
        alt=""
      />
    </button>
  );
}

/**
 * Back/forward pair plus the connection pill. Chrome that every page carries,
 * so it lives with the shell rather than with one page's content. Both buttons
 * walk the window's one history, and each is inert at that history's end.
 */
function PageHeader() {
  const { canGoBack, canGoForward, goBack, goForward } = useNavigation();

  return (
    // This strip is the page's share of the title bar the window does not have,
    // so it drags the window; the buttons inside it opt back out.
    <header
      className="app-drag flex shrink-0 items-center justify-between px-6 py-3 backdrop-blur-[11.634px]"
      data-testid="page-header"
    >
      <div className="app-no-drag flex h-[28px] items-center overflow-hidden rounded-full border border-black/8 bg-white/50 shadow-[0px_2.493px_9.972px_0px_rgba(0,0,0,0.05)]">
        <HistoryButton
          direction="back"
          onClick={goBack}
          disabled={!canGoBack}
          isFirst
        />
        <HistoryButton direction="forward" onClick={goForward} disabled={!canGoForward} />
      </div>

      <span
        className="flex items-center justify-center gap-1.5 rounded-full border-[0.829px] border-pill-border bg-pill-bg px-2 py-1"
        data-testid="connection-pill"
      >
        <span className="size-[6px] shrink-0 rounded-[3px] bg-status-live" />
        <span className="text-[11px] leading-[13px] font-bold text-pill-text">Tokkey connected</span>
      </span>
    </header>
  );
}

interface PageShellProps {
  /** Page heading, e.g. "Tokkey". */
  title: string;
  /** Sentence under the heading, where the design gives the page one. */
  subtitle?: string;
  /** Identifies the page in tests, e.g. `tokkey` renders `page-tokkey`. */
  testId: string;
  children: ReactNode;
}

/**
 * The right-hand content page: header, heading block, then the page's own
 * sections. Every page renders through this so they share one frame.
 */
export function PageShell({ title, subtitle, testId, children }: PageShellProps) {
  return (
    <main
      // `overflow-hidden` is load-bearing: the header's backdrop-filter is
      // promoted to its own layer, which a bare border-radius does not clip, so
      // without it the blur paints square over the page's rounded top corners.
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white"
      data-testid={`page-${testId}`}
    >
      <PageHeader />
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        <TitleBlock title={title} subtitle={subtitle} size="page" as="h1" />
        {children}
      </div>
    </main>
  );
}

/**
 * Body for pages that are navigable but not designed yet, so selecting their
 * nav row lands somewhere honest instead of on an empty frame.
 */
export function PagePlaceholder({ children }: { children: ReactNode }) {
  return (
    <p
      className="flex w-full items-center justify-center rounded-[12px] border border-surface-card-border bg-surface-card p-6 text-[12px] leading-[14px] text-text-secondary"
      data-testid="page-placeholder"
    >
      {children}
    </p>
  );
}
