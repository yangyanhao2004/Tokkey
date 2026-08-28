import { PushButton } from './PushButton';

export interface PaginationBarProps {
  /** Zero-based, as the service counts pages. */
  page: number;
  pageCount: number;
  /** Which slice is on screen, e.g. "21–40 of 3,214". */
  summary: string;
  previousLabel: string;
  nextLabel: string;
  disabled?: boolean;
  onPageChange: (page: number) => void;
}

/**
 * The row under a listing too long to draw at once: which slice is on screen,
 * and the two steps either side of it.
 *
 * It sits outside the scroll area of the tab that draws it, so paging is
 * reachable without scrolling to the end of the twenty cards above it.
 */
export function PaginationBar({
  page,
  pageCount,
  summary,
  previousLabel,
  nextLabel,
  disabled = false,
  onPageChange
}: PaginationBarProps) {
  return (
    <div
      className="flex w-full shrink-0 items-center justify-between gap-2 pt-2"
      data-testid="pagination"
    >
      <span className="text-[10px] leading-[12px] text-text-secondary" data-testid="pagination-summary">
        {summary}
      </span>

      <div className="flex shrink-0 items-center gap-2">
        <PushButton
          variant="tinted"
          disabled={disabled || page === 0}
          onClick={() => onPageChange(page - 1)}
          testId="pagination-previous"
        >
          {previousLabel}
        </PushButton>

        <span className="text-[10px] leading-[12px] text-text-secondary" data-testid="pagination-position">
          {`${page + 1} / ${pageCount}`}
        </span>

        <PushButton
          variant="tinted"
          disabled={disabled || page + 1 >= pageCount}
          onClick={() => onPageChange(page + 1)}
          testId="pagination-next"
        >
          {nextLabel}
        </PushButton>
      </div>
    </div>
  );
}
