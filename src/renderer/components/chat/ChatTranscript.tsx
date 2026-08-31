import { useState } from 'react';
import {
  formatConversationDate,
  ICON_BASE_PATH,
  type ChatMessage,
  type ChatSession
} from '../../pages/chatContent';
import { TokenUsagePopover } from './TokenUsagePopover';

interface ChatTranscriptProps {
  session: ChatSession;
  onCopyMessage: (message: ChatMessage) => Promise<void>;
  copyStateByMessageId: Readonly<Record<string, 'idle' | 'copied' | 'error'>>;
}

function EmptyState() {
  return (
    <div className="relative flex min-h-full flex-col items-center pt-3" data-testid="chat-empty-state">
      <time className="text-[10px] leading-3 tracking-[0.12px] text-chat-secondary-text">Today</time>
      <div className="mt-[60px] flex w-[470px] max-w-full flex-col items-center gap-3 px-4">
        <div className="flex size-12 items-center justify-center rounded-xl bg-chat-empty-tile">
          <img className="block size-[26px] max-w-none" src={`${ICON_BASE_PATH}/chat-empty.svg`} alt="" />
        </div>
        <h1 className="text-center text-[20px] leading-6 font-bold text-chat-heading">Private Chat</h1>
        <p className="text-center text-[13px] leading-4 text-chat-secondary-text">A truly private chat for your Mac.</p>
        <ul className="flex flex-col gap-2 text-[12px] leading-4 text-chat-secondary-text">
          <li className="flex items-center gap-2">
            <img className="block size-4 max-w-none" src={`${ICON_BASE_PATH}/chat-local.svg`} alt="" />
            <span>Everything runs locally.</span>
          </li>
          <li className="flex items-center gap-2 opacity-80">
            <img className="block size-4 max-w-none" src={`${ICON_BASE_PATH}/chat-shield.svg`} alt="" />
            <span>Your prompts, context, and documents never leave your device.</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end" data-testid="chat-user-message">
      <div className="flex max-w-[min(100%,372px)] items-end">
        <div className="break-words rounded-2xl bg-chat-user-bubble px-3 py-1.5 text-[12px] leading-4 text-white">
          {message.content}
        </div>
        <span className="-ml-[7px] block h-[15.949px] w-[13.198px] shrink-0 -scale-y-100 rotate-180" aria-hidden="true">
          <img className="block size-full max-w-none" src={`${ICON_BASE_PATH}/chat-message-tail.svg`} alt="" />
        </span>
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  onCopy,
  copyState
}: {
  message: ChatMessage;
  onCopy: () => Promise<void>;
  copyState: 'idle' | 'copied' | 'error';
}) {
  const [isCopying, setIsCopying] = useState(false);
  const [usageIsOpen, setUsageIsOpen] = useState(false);

  const handleCopy = async () => {
    setIsCopying(true);
    await onCopy();
    setIsCopying(false);
  };
  const copyLabel = copyState === 'copied'
    ? 'Assistant response copied'
    : copyState === 'error'
      ? 'Copy assistant response failed'
      : 'Copy assistant response';

  return (
    <article className="flex flex-col gap-3" data-testid="chat-assistant-message">
      <h2 className="py-1 text-[12px] leading-[18px] font-semibold text-white">Tokiie</h2>
      <p className="whitespace-pre-wrap break-words py-1 text-[12px] leading-[1.8] text-white">
        {message.content || 'Thinking…'}
      </p>
      <div className="relative flex items-center gap-2 px-1 py-2 text-[10px] text-chat-tertiary-text">
        <button
          type="button"
          className="flex size-4 items-center justify-center rounded hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
          onClick={() => void handleCopy()}
          disabled={isCopying || !message.content}
          aria-label={copyLabel}
          title={copyLabel}
          data-testid={`chat-copy-${message.id}`}
        >
          <img className="block size-4 max-w-none" src={`${ICON_BASE_PATH}/chat-copy.svg`} alt="" />
        </button>
        {message.tokenUsage && (
          <button
            type="button"
            className="flex size-4 items-center justify-center rounded hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
            onClick={() => setUsageIsOpen((isOpen) => !isOpen)}
            aria-label="Show token usage"
            aria-expanded={usageIsOpen}
            data-testid={`chat-token-usage-trigger-${message.id}`}
          >
            <img className="block size-4 max-w-none" src={`${ICON_BASE_PATH}/chat-response-timer.svg`} alt="" />
          </button>
        )}
        {message.durationLabel && <span aria-label={`Response time ${message.durationLabel}`}>{message.durationLabel}</span>}
        {usageIsOpen && message.tokenUsage && (
          <TokenUsagePopover usage={message.tokenUsage} onClose={() => setUsageIsOpen(false)} />
        )}
      </div>
    </article>
  );
}

export function ChatTranscript({ session, onCopyMessage, copyStateByMessageId }: ChatTranscriptProps) {
  if (session.messages.length === 0) return <EmptyState />;

  return (
    <div className="flex min-h-full flex-col gap-3 p-6" data-testid="chat-message-list" tabIndex={-1}>
      <time className="text-center text-[10px] leading-3 text-white/75" dateTime={new Date(session.updatedAt).toISOString()}>
        {formatConversationDate(session.updatedAt)}
      </time>
      {session.messages.map((message) => message.role === 'user' ? (
        <UserMessage key={message.id} message={message} />
      ) : (
        <AssistantMessage
          key={message.id}
          message={message}
          onCopy={() => onCopyMessage(message)}
          copyState={copyStateByMessageId[message.id] ?? 'idle'}
        />
      ))}
    </div>
  );
}
