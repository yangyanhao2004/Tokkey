import { useRef } from 'react';
import { ICON_BASE_PATH, paginateEarlier, searchHistory, summarizeSession, type ChatSession } from '../../pages/chatContent';
import { ChatHistoryPopover } from './ChatHistoryPopover';

interface ChatTabBarProps {
  sessions: ChatSession[];
  activeSessionId: string;
  historyIsOpen: boolean;
  historyQuery: string;
  historyGroups: { label: 'Today' | '7Days' | 'Earlier'; items: ReturnType<typeof summarizeSession>[] }[];
  historyResults: ReturnType<typeof searchHistory>;
  earlierPage: number;
  earlierPageItems: ReturnType<typeof paginateEarlier>['items'];
  hasEarlierPage: boolean;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onCreateChat: () => void;
  onOpenHistory: () => void;
  onCloseHistory: () => void;
  onHistoryQueryChange: (query: string) => void;
  onChangeEarlierPage: (page: number) => void;
}

function ChatTab({
  session,
  isActive,
  isFirst,
  isLast,
  onSelect,
  onClose
}: {
  session: ChatSession;
  isActive: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={`app-no-drag relative flex h-9 min-w-0 flex-1 items-center ${isActive ? 'bg-chat-surface' : 'bg-chat-tab-bar'} ${!isFirst ? '-ml-4 pl-4' : ''}`}
      data-testid={`chat-tab-${session.id}`}
    >
      {!isFirst && (
        <img
          className="pointer-events-none absolute left-0 top-0 z-10 h-[36px] w-4 max-w-none"
          src={`${ICON_BASE_PATH}/chat-tab-fold-leading.svg`}
          alt=""
        />
      )}
      <button
        type="button"
        className="flex h-9 min-w-0 flex-1 items-center gap-1 px-3 text-left focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-white"
        onClick={onSelect}
        aria-current={isActive ? 'page' : undefined}
        aria-label={`Open ${session.title}`}
      >
        <img className="block h-[13px] w-[14px] shrink-0 max-w-none text-white/75" src={`${ICON_BASE_PATH}/chat-tab-sparkles.svg`} alt="" />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-white">{session.title}</span>
      </button>
      {isLast && <img className="pointer-events-none absolute right-0 top-0 z-10 h-[36px] w-4 max-w-none" src={`${ICON_BASE_PATH}/chat-tab-fold-trailing.svg`} alt="" />}
      <button
        type="button"
        className="absolute right-0 top-1/2 z-20 flex size-6 -translate-y-1/2 items-center justify-center rounded text-white/85 focus-visible:outline-2 focus-visible:outline-white"
        onClick={onClose}
        aria-label={`Close ${session.title}`}
      >
        <img className="block h-[14px] w-[11px] max-w-none" src={`${ICON_BASE_PATH}/chat-tab-close.svg`} alt="" />
      </button>
    </div>
  );
}

export function ChatTabBar({
  sessions,
  activeSessionId,
  historyIsOpen,
  historyQuery,
  historyGroups,
  historyResults,
  earlierPage,
  earlierPageItems,
  hasEarlierPage,
  onSelectSession,
  onCloseSession,
  onCreateChat,
  onOpenHistory,
  onCloseHistory,
  onHistoryQueryChange,
  onChangeEarlierPage
}: ChatTabBarProps) {
  const historyButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <header className="app-drag relative flex h-[42px] shrink-0 items-end gap-4 overflow-visible bg-chat-tab-bar pr-3 pt-[6px]" data-testid="chat-tab-bar">
      <div className="flex h-9 min-w-0 flex-1 items-end overflow-hidden">
        {sessions.map((session, index) => (
          <ChatTab
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            isFirst={index === 0}
            isLast={index === sessions.length - 1}
            onSelect={() => onSelectSession(session.id)}
            onClose={() => onCloseSession(session.id)}
          />
        ))}
      </div>
      <img className="mb-[13px] block h-px w-[13px] shrink-0 rotate-90" src={`${ICON_BASE_PATH}/chat-tab-divider.svg`} alt="" />
      <div className="app-no-drag relative mb-[7px] flex h-6 shrink-0 overflow-visible rounded-full border border-white/10 bg-white/5" data-testid="chat-tab-actions">
        <button
          type="button"
          className="flex w-[26px] items-center justify-center border-r border-white/10 focus-visible:outline-2 focus-visible:outline-white"
          onClick={onCreateChat}
          aria-label="New private chat"
          title="New private chat"
          data-testid="chat-new"
        >
          <img className="block size-[14px] max-w-none" src={`${ICON_BASE_PATH}/chat-new.svg`} alt="" />
        </button>
        <button
          ref={historyButtonRef}
          type="button"
          className="flex w-[26px] items-center justify-center focus-visible:outline-2 focus-visible:outline-white"
          onClick={historyIsOpen ? onCloseHistory : onOpenHistory}
          aria-expanded={historyIsOpen}
          aria-haspopup="dialog"
          aria-label="Private chat history"
          title="Private chat history"
          data-testid="chat-history-trigger"
        >
          <img className="block size-[14px] max-w-none" src={`${ICON_BASE_PATH}/chat-history.svg`} alt="" />
        </button>
        {historyIsOpen && (
          <ChatHistoryPopover
            query={historyQuery}
            browseGroups={historyGroups}
            searchResults={historyResults}
            earlierPage={earlierPage}
            earlierPageItems={earlierPageItems}
            hasEarlierPage={hasEarlierPage}
            onQueryChange={onHistoryQueryChange}
            onSelectSession={onSelectSession}
            onChangeEarlierPage={onChangeEarlierPage}
            onClose={onCloseHistory}
            onRestoreFocus={() => historyButtonRef.current?.focus()}
          />
        )}
      </div>
    </header>
  );
}
