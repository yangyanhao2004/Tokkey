import { useChatSession } from '../hooks/useChatSession';
import { ChatComposer } from '../components/chat/ChatComposer';
import { ChatTabBar } from '../components/chat/ChatTabBar';
import { ChatTranscript } from '../components/chat/ChatTranscript';

/** The fixed-dark Chat workspace; all content is renderer-local in this phase. */
export function ChatPage() {
  const chat = useChatSession();
  const isEmpty = chat.activeSession.messages.length === 0;
  const frameClassName = isEmpty
    ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[16px] border border-chat-border bg-chat-surface'
    : 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-chat-border bg-chat-surface';

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
          historyQuery={chat.historyQuery}
          historyGroups={chat.historyGroups}
          historyResults={chat.historyResults}
          onSelectSession={chat.selectSession}
          onCloseSession={chat.closeSession}
          onCreateChat={chat.createNewChat}
          onOpenHistory={chat.openHistory}
          onCloseHistory={chat.closeHistory}
          onHistoryQueryChange={chat.setHistoryQuery}
        />
        <section className="min-h-0 flex-1 overflow-y-auto bg-chat-surface" data-testid="chat-body">
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
