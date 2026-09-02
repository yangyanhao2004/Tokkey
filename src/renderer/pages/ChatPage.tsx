import { useEffect, useLayoutEffect, useRef } from 'react';
import { useChatSession } from '../hooks/useChatSession';
import { ChatComposer } from '../components/chat/ChatComposer';
import { ChatTabBar } from '../components/chat/ChatTabBar';
import { ChatTranscript } from '../components/chat/ChatTranscript';

const CHAT_BOTTOM_TOLERANCE_PX = 24;

function isNearScrollBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_BOTTOM_TOLERANCE_PX;
}

/** The fixed-dark Chat workspace backed by the local-only Chat data path. */
export function ChatPage() {
  const chat = useChatSession();
  const chatBodyRef = useRef<HTMLElement>(null);
  const shouldFollowTranscriptRef = useRef(true);
  const previousSessionIdRef = useRef(chat.activeSessionId);
  const isEmpty = chat.activeSession.messages.length === 0;
  const frameClassName = isEmpty
    ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[16px] border border-chat-border bg-chat-surface'
    : 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-chat-border bg-chat-surface';

  useEffect(() => {
    const chatBody = chatBodyRef.current;
    if (!chatBody) return;

    const updateTranscriptFollowState = () => {
      shouldFollowTranscriptRef.current = isNearScrollBottom(chatBody);
    };

    updateTranscriptFollowState();
    chatBody.addEventListener('scroll', updateTranscriptFollowState, { passive: true });
    return () => chatBody.removeEventListener('scroll', updateTranscriptFollowState);
  }, []);

  useLayoutEffect(() => {
    const chatBody = chatBodyRef.current;
    if (!chatBody) return;

    const sessionChanged = previousSessionIdRef.current !== chat.activeSessionId;
    previousSessionIdRef.current = chat.activeSessionId;
    if (sessionChanged) {
      shouldFollowTranscriptRef.current = true;
    }
    if (shouldFollowTranscriptRef.current) {
      chatBody.scrollTop = chatBody.scrollHeight;
    }
  }, [chat.activeSessionId, chat.activeSession.messages]);

  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[20px] bg-chat-surface"
      data-testid="page-chat"
    >
      <div className={frameClassName} data-testid="chat-frame">
        <ChatTabBar
          sessions={chat.openSessions}
          activeSessionId={chat.activeSessionId}
          historyIsOpen={chat.historyMode !== 'closed'}
          historyGroups={chat.historyGroups}
          onSelectSession={chat.selectSession}
          onCloseSession={chat.closeSession}
          onCreateChat={chat.createNewChat}
          onOpenHistory={chat.openHistory}
          onCloseHistory={chat.closeHistory}
        />
        <section ref={chatBodyRef} className="min-h-0 flex-1 overflow-y-auto bg-chat-surface" data-testid="chat-body">
          <ChatTranscript
            session={chat.activeSession}
            onCopyMessage={chat.copyMessage}
            copyStateByMessageId={chat.copyStateByMessageId}
          />
        </section>
        <ChatComposer
          isEmpty={isEmpty}
          model={chat.selectedModel}
          modelState={chat.modelState}
          requestState={chat.requestState}
          onSend={chat.sendMessage}
          onStop={chat.stopStreaming}
        />
      </div>
    </main>
  );
}
