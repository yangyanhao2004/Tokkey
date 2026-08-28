import type { ReactNode } from 'react';
import {
  SEARCH_LABEL,
  SEARCH_PLACEHOLDER,
  type AgentAvailability,
  type CatalogEntry,
  type CatalogMessageTone,
  type CatalogNotice
} from '../pages/agentHubContent';
import { CatalogCard } from './CatalogCard';
import { SearchField } from './SearchField';

/** A notice the user has to act on is red; everything else stays quiet. */
const MESSAGE_TONE_CLASSES: Record<CatalogMessageTone, string> = {
  neutral: 'text-text-secondary',
  error: 'text-status-error-text'
};

export interface CatalogMessageProps {
  children: ReactNode;
  tone?: CatalogMessageTone;
  testId?: string;
}

/** The single line a tab shows in place of, or above, its grid. */
export function CatalogMessage({ children, tone = 'neutral', testId }: CatalogMessageProps) {
  return (
    <p
      className={`w-full py-2 text-[10px] leading-[12px] ${MESSAGE_TONE_CLASSES[tone]}`}
      data-testid={testId}
      data-tone={tone}
    >
      {children}
    </p>
  );
}

export interface CatalogGridProps {
  entries: readonly CatalogEntry[];
  availability: AgentAvailability;
  /** Omitted by tabs whose entries have nothing to manage yet. */
  onManage?: (entryId: string) => void;
}

/** The two-column grid of whatever the open tab holds. */
export function CatalogGrid({ entries, availability, onManage }: CatalogGridProps) {
  return (
    <div className="grid w-full grid-cols-2 gap-3">
      {entries.map((entry) => (
        <CatalogCard
          key={entry.id}
          entry={entry}
          availability={availability}
          onManage={onManage ? () => onManage(entry.id) : undefined}
        />
      ))}
    </div>
  );
}

export interface CatalogTabLayoutProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** The tab's own buttons, e.g. Upload and Discover. */
  actions: ReactNode;
  /** One line about the last action, held above the scroll area. */
  notice?: CatalogNotice | null;
  /** The grid, plus whatever the tab says in place of it. */
  children: ReactNode;
}

/**
 * The chrome both catalog tabs repeat: search on the left, the tab's actions on
 * the right, then everything the tab draws below.
 *
 * It renders no wrapper of its own so the section it sits in keeps laying out
 * these rows directly, which is what holds the grid inside the window.
 */
export function CatalogTabLayout({
  query,
  onQueryChange,
  actions,
  notice = null,
  children
}: CatalogTabLayoutProps) {
  return (
    <>
      <div className="flex w-full shrink-0 items-center justify-between gap-2">
        <div className="w-[180px] shrink-0">
          <SearchField
            value={query}
            onChange={onQueryChange}
            placeholder={SEARCH_PLACEHOLDER}
            label={SEARCH_LABEL}
            testId="catalog-search"
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>

      {/* Above the scroll area, so an outcome cannot be scrolled out of sight. */}
      {notice && (
        <div className="w-full shrink-0">
          <CatalogMessage tone={notice.tone} testId="catalog-upload-notice">
            {notice.message}
          </CatalogMessage>
        </div>
      )}

      {/* `min-h-0` keeps a catalog of any length inside the page rather than
          pushing the window's content out of view. */}
      <div className="min-h-0 w-full flex-1 overflow-y-auto">{children}</div>
    </>
  );
}
