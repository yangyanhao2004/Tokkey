import type { ReactNode } from 'react';

/**
 * The two type scales the design uses for a headline/subheadline pair:
 * `page` is the heading at the top of a page, `card` is every heading inside a
 * card, list row, or section. Figma varies the sub-pixel letter-spacing between
 * card instances (0.05px-0.1px); one value is used here so the pairs match.
 */
const SIZE_CLASSES = {
  page: {
    title: 'text-[20px] leading-[24px]',
    subtitle: 'text-[12px] leading-[14px]'
  },
  card: {
    title: 'text-[12px] leading-[14px]',
    subtitle: 'text-[10px] leading-[12px]'
  }
} as const;

interface TitleBlockProps {
  /** The headline, e.g. "Local Models". */
  title: ReactNode;
  /** The line under it, e.g. "Download, start, and manage models on this Mac." */
  subtitle: ReactNode;
  size?: keyof typeof SIZE_CLASSES;
  /**
   * Heading level for the title. Pages use `h1` and cards `h2`; rows that
   * repeat inside a list are not document headings, so they keep the `span`.
   */
  as?: 'h1' | 'h2' | 'h3' | 'span';
  testId?: string;
}

/**
 * A headline with its subheadline. Every card, row, and page header renders
 * through this so the pairs share one type scale and spacing.
 *
 * Both lines truncate, which needs the parent to allow shrinking - place this
 * inside a flex container whose item does not have a fixed width.
 */
export function TitleBlock({
  title,
  subtitle,
  size = 'card',
  as: TitleTag = 'span',
  testId
}: TitleBlockProps) {
  const classes = SIZE_CLASSES[size];

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <TitleTag className={`truncate font-bold text-text-primary ${classes.title}`}>
        {title}
      </TitleTag>
      <span className={`truncate text-text-secondary ${classes.subtitle}`}>{subtitle}</span>
    </div>
  );
}
