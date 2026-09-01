import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  formatHistoryTime,
  ICON_BASE_PATH,
  type ChatSessionSummary
} from '../../pages/chatContent';

interface ChatHistoryPopoverProps {
  browseGroups: { label: 'Today' | '7Days' | 'Earlier'; items: ChatSessionSummary[] }[];
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
  onRestoreFocus: () => void;
}

interface HistoryRowProps {
  session: ChatSessionSummary;
  index: number;
  activeIndex: number;
  onSelect: () => void;
}

function HistoryRow({ session, index, activeIndex, onSelect }: HistoryRowProps) {
  return (
    <button
      id={`chat-history-option-${session.id}`}
      type="button"
      role="option"
      aria-selected={index === activeIndex}
      tabIndex={index === activeIndex ? 0 : -1}
      className={`app-no-drag flex h-6 w-full items-center gap-2 rounded-[4px] px-1.5 text-left focus-visible:outline-2 focus-visible:outline-white ${index === activeIndex ? 'bg-white/10' : 'hover:bg-white/10'}`}
      onClick={onSelect}
      aria-label={`${session.title}, last updated ${formatHistoryTime(session.updatedAt)}`}
      data-testid={`chat-history-row-${session.id}`}
    >
      <img className="block size-[13px] shrink-0 max-w-none" src={`${ICON_BASE_PATH}/chat-history-clock.svg`} alt="" />
      <span className="min-w-0 flex-1 truncate text-[14px] leading-4 font-medium text-white">
        {session.title}
      </span>
    </button>
  );
}

export function ChatHistoryPopover({
  browseGroups,
  onSelectSession,
  onClose,
  onRestoreFocus
}: ChatHistoryPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const visibleGroups = browseGroups.filter((group) => group.items.length > 0);
  const visibleSessions = visibleGroups.flatMap((group) => group.items);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (visibleSessions.length > 0) {
        document.getElementById(`chat-history-option-${visibleSessions[0].id}`)?.focus();
        return;
      }
      popoverRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      onClose();
      onRestoreFocus();
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [onClose, onRestoreFocus]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      onRestoreFocus();
      return;
    }
    if (!visibleSessions.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      onSelectSession(visibleSessions[activeIndex]?.id ?? visibleSessions[0].id);
      return;
    }
    event.preventDefault();
    const nextIndex = event.key === 'ArrowDown'
      ? (activeIndex + 1) % visibleSessions.length
      : (activeIndex - 1 + visibleSessions.length) % visibleSessions.length;
    setActiveIndex(nextIndex);
    requestAnimationFrame(() => document.getElementById(`chat-history-option-${visibleSessions[nextIndex].id}`)?.focus());
  };

  return (
    <div
      ref={popoverRef}
      className="app-no-drag absolute right-0 top-[38px] z-30 flex h-[252px] w-[240px] flex-col overflow-hidden rounded-[13px] border border-white/10 bg-chat-glass p-3 shadow-[0_0_2px_rgba(0,0,0,0.1),0_0_25px_rgba(0,0,0,0.16)] backdrop-blur-xl"
      role="dialog"
      aria-label="Private chat history"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      data-testid="chat-history-popover"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" role="listbox" aria-label="Private chat history" data-testid="chat-history-list">
        {visibleGroups.map((group, groupIndex) => (
          <div key={group.label}>
            {groupIndex > 0 && <div className="my-[5px] h-px bg-white/30" />}
            <h3 className="px-[18px] pb-1 pt-[5px] text-[12px] leading-4 font-bold text-white/75">{group.label}</h3>
            {group.items.map((session) => (
              <HistoryRow
                key={session.id}
                session={session}
                index={visibleSessions.findIndex((item) => item.id === session.id)}
                activeIndex={activeIndex}
                onSelect={() => onSelectSession(session.id)}
              />
            ))}
          </div>
        ))}
        {visibleGroups.length === 0 && <p className="px-1.5 py-2 text-[12px] text-white/75">No conversations yet</p>}
      </div>
    </div>
  );
}
