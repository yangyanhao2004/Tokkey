import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  formatHistoryTime,
  getTitleMatchParts,
  ICON_BASE_PATH,
  type ChatSessionSummary
} from '../../pages/chatContent';

interface ChatHistoryPopoverProps {
  query: string;
  browseGroups: { label: 'Today' | '7Days' | 'Earlier'; items: ChatSessionSummary[] }[];
  searchResults: ChatSessionSummary[];
  onQueryChange: (query: string) => void;
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
  onRestoreFocus: () => void;
}

interface HistoryRowProps {
  session: ChatSessionSummary;
  query: string;
  index: number;
  activeIndex: number;
  onSelect: () => void;
}

function HistoryRow({ session, query, index, activeIndex, onSelect }: HistoryRowProps) {
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
        {getTitleMatchParts(session.title, query).map((part, partIndex) => part.matches
          ? <mark key={`${session.id}-match-${partIndex}`} className="rounded-[3px] bg-white/20 text-white">{part.text}</mark>
          : <span key={`${session.id}-text-${partIndex}`}>{part.text}</span>)}
      </span>
    </button>
  );
}

export function ChatHistoryPopover({
  query,
  browseGroups,
  searchResults,
  onQueryChange,
  onSelectSession,
  onClose,
  onRestoreFocus
}: ChatHistoryPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    searchRef.current?.focus();
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

  const isSearching = query.trim().length > 0;
  const visibleGroups = browseGroups
    .filter((group) => group.label !== 'Earlier')
    .filter((group) => group.items.length > 0);
  const browseItems = visibleGroups.flatMap((group) => group.items);
  const visibleSessions = isSearching ? searchResults : browseItems;

  useEffect(() => setActiveIndex(0), [query]);

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
      className={`app-no-drag absolute right-0 top-[38px] z-30 flex w-[240px] flex-col gap-4 overflow-hidden rounded-[13px] border border-white/10 bg-chat-glass p-3 shadow-[0_0_2px_rgba(0,0,0,0.1),0_0_25px_rgba(0,0,0,0.16)] backdrop-blur-xl ${isSearching ? 'h-[112px]' : 'h-[252px]'}`}
      role="dialog"
      aria-label="Private chat history"
      onKeyDown={handleKeyDown}
      data-testid="chat-history-popover"
    >
      <div className="flex h-6 w-full shrink-0 items-center gap-0.5 rounded-full border border-black/8 bg-white/90 px-2 shadow-[0_0_0_1px_rgba(0,122,255,0.15)] focus-within:ring-[3.5px] focus-within:ring-white/25">
        <img className="block h-[15px] w-4 shrink-0 max-w-none text-black" src={`${ICON_BASE_PATH}/chat-history-search.svg`} alt="" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search"
          onChange={(event) => onQueryChange(event.target.value)}
          className="min-w-0 flex-1 appearance-none select-text bg-transparent text-[10px] leading-4 font-medium text-black outline-none placeholder:text-black/50"
          aria-label="Search private chat history"
          autoComplete="off"
          spellCheck={false}
          data-testid="chat-history-search"
        />
        {query && (
          <button
            type="button"
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-black/55 hover:text-black focus-visible:outline-2 focus-visible:outline-black"
            onClick={() => {
              onQueryChange('');
              searchRef.current?.focus();
            }}
            aria-label="Clear private chat history search"
          >
            <img className="block size-4 max-w-none" src={`${ICON_BASE_PATH}/chat-history-clear.svg`} alt="" />
          </button>
        )}
      </div>

      {isSearching ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" role="listbox" aria-label="Matching private chat history" data-testid="chat-history-results">
          {searchResults.map((session, index) => (
            <HistoryRow key={session.id} session={session} query={query} index={index} activeIndex={activeIndex} onSelect={() => onSelectSession(session.id)} />
          ))}
          {searchResults.length === 0 && <p className="px-1.5 py-2 text-[12px] text-white/75">No conversations found</p>}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" role="listbox" aria-label="Private chat history" data-testid="chat-history-list">
          {visibleGroups.map((group, groupIndex) => (
            <div key={group.label}>
              {groupIndex > 0 && <div className="my-[5px] h-px bg-white/30" />}
              <h3 className="px-[18px] pb-1 pt-[5px] text-[12px] leading-4 font-bold text-white/75">{group.label}</h3>
              {group.items.map((session) => (
                <HistoryRow key={session.id} session={session} query="" index={browseItems.findIndex((item) => item.id === session.id)} activeIndex={activeIndex} onSelect={() => onSelectSession(session.id)} />
              ))}
            </div>
          ))}
          {visibleGroups.length === 0 && <p className="px-1.5 py-2 text-[12px] text-white/75">No conversations yet</p>}
        </div>
      )}
    </div>
  );
}
