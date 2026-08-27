import type { ReactNode } from 'react';
import { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';
import { TitleBlock } from './TitleBlock';

interface PageHeaderProps {
  /** Supplied only by pages opened from another page; elsewhere Back is inert. */
  onBack?: () => void;
}

/**
 * Back/forward pair plus the connection pill. Chrome that every page carries,
 * so it lives with the shell rather than with one page's content.
 */
function PageHeader({ onBack }: PageHeaderProps) {
  return (
    // This strip is the page's share of the title bar the window does not have,
    // so it drags the window; the buttons inside it opt back out.
    <header
      className="app-drag flex shrink-0 items-center justify-between px-6 py-3 backdrop-blur-[11.634px]"
      data-testid="page-header"
    >
      <div className="app-no-drag flex h-[28px] items-center overflow-hidden rounded-full border border-black/8 bg-white/50 shadow-[0px_2.493px_9.972px_0px_rgba(0,0,0,0.05)]">
        <button
          type="button"
          className="flex h-[28px] w-[30px] items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary"
          onClick={onBack}
          disabled={!onBack}
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

interface PageShellProps {
  /** Page heading, e.g. "Tokiie". */
  title: string;
  /** Sentence under the heading. */
  subtitle: string;
  /** Identifies the page in tests, e.g. `tokiie` renders `page-tokiie`. */
  testId: string;
  /** Passed through to the header's Back button; omit on top-level pages. */
  onBack?: () => void;
  children: ReactNode;
}

/**
 * The right-hand content page: header, heading block, then the page's own
 * sections. Every page renders through this so they share one frame.
 */
export function PageShell({ title, subtitle, testId, onBack, children }: PageShellProps) {
  return (
    <main
      // `overflow-hidden` is load-bearing: the header's backdrop-filter is
      // promoted to its own layer, which a bare border-radius does not clip, so
      // without it the blur paints square over the page's rounded top corners.
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white"
      data-testid={`page-${testId}`}
    >
      <PageHeader onBack={onBack} />
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
