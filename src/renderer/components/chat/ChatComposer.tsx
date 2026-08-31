import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ICON_BASE_PATH, type ChatModelOption, type ChatModelState } from '../../pages/chatContent';

interface ChatComposerProps {
  isEmpty: boolean;
  model: ChatModelOption | null;
  modelState: ChatModelState;
  requestState: 'idle' | 'sending' | 'error';
  onSend: (message: string) => void;
  onStop: () => void;
}

const EMPTY_TEXTAREA_HEIGHT = 80;
const CONVERSATION_TEXTAREA_HEIGHT = 60;
const MAX_TEXTAREA_HEIGHT = 120;

export function ChatComposer({ isEmpty, model, modelState, requestState, onSend, onStop }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const baseTextareaHeight = isEmpty ? EMPTY_TEXTAREA_HEIGHT : CONVERSATION_TEXTAREA_HEIGHT;
  const canSend = Boolean(draft.trim()) && Boolean(model?.isAvailable) && modelState === 'available' && requestState !== 'sending';
  const canStop = requestState === 'sending';

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = `${baseTextareaHeight}px`;
    if (!draft) return;
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, baseTextareaHeight), MAX_TEXTAREA_HEIGHT)}px`;
  }, [baseTextareaHeight, draft]);

  const submit = () => {
    if (!canSend) return;
    onSend(draft);
    setDraft('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const unavailableLabel = modelState === 'loading'
    ? 'Loading local model'
    : modelState === 'error'
      ? 'Local model unavailable'
      : 'No local model available';

  return (
    <footer
      className="flex shrink-0 flex-col gap-2 rounded-b-xl bg-chat-surface px-3"
      data-testid="chat-composer"
    >
      <div className="flex min-h-[110px] flex-col overflow-hidden rounded-[10px] border border-chat-input-border bg-chat-input">
        <label className="sr-only" htmlFor="chat-message-input">Message your local model</label>
        <textarea
          ref={textareaRef}
          id="chat-message-input"
          value={draft}
          className="min-h-[60px] resize-none overflow-y-auto bg-transparent px-4 pt-4 text-[12px] leading-4 text-white outline-none placeholder:text-chat-placeholder select-text"
          placeholder="Message your local model…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          data-testid="chat-input"
        />
        <div className="flex h-12 items-end justify-between px-2 pb-2 pt-1">
          <button
            type="button"
            disabled
            className="flex size-8 items-center justify-center rounded-[9px] text-white/70 opacity-80"
            aria-label="Add document (coming soon)"
            title="Coming soon"
            data-testid="chat-add-document"
          >
            <img className="block size-4 max-w-none" src={`${ICON_BASE_PATH}/chat-document.svg`} alt="" />
          </button>
          <div className="flex items-center gap-2">
            <div
              className="flex h-[30px] max-w-[124px] items-center gap-1.5 truncate rounded-lg border border-chat-model-border bg-chat-model px-2 text-[10px] text-chat-model-label"
              aria-label={model ? `Selected local model: ${model.label}` : unavailableLabel}
              data-testid="chat-model-selector"
            >
              <span className={`size-1.5 shrink-0 rounded-[3px] ${model ? 'bg-chat-live' : 'bg-white/35'}`} />
              <span className="truncate">{model?.label ?? unavailableLabel}</span>
            </div>
            <button
              type="button"
              className="flex size-[30px] items-center justify-center rounded-[9px] bg-chat-send text-black disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-white"
              disabled={!canSend && !canStop}
              onClick={canStop ? onStop : submit}
              aria-label={canStop ? 'Stop generating' : 'Send message'}
              title={canStop ? 'Stop generating' : 'Send message'}
              data-testid={canStop ? 'chat-stop' : 'chat-send'}
            >
              {canStop ? (
                <span className="size-3 rounded-[2px] bg-black" aria-hidden="true" />
              ) : (
                <img className="block size-[14px] max-w-none" src={`${ICON_BASE_PATH}/chat-send.svg`} alt="" />
              )}
            </button>
          </div>
        </div>
      </div>
      <p className="min-h-[18px] px-3 pb-1 text-[8px] leading-[10px] text-chat-footnote">
        Documents are processed locally · nothing leaves this Mac.
      </p>
    </footer>
  );
}
