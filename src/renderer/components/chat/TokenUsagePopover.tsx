import { useEffect, useRef } from 'react';
import { type TokenUsageFixture } from '../../pages/chatContent';

interface TokenUsagePopoverProps {
  usage: TokenUsageFixture;
  onClose: () => void;
}

/** Static renderer fixture for the Figma Token Usage menu; it has no billing logic. */
export function TokenUsagePopover({ usage, onClose }: TokenUsagePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-8 left-0 z-40 flex w-[240px] flex-col gap-4 rounded-[13px] bg-chat-glass p-3 text-white shadow-[0_0_2px_rgba(0,0,0,0.1),0_0_25px_rgba(0,0,0,0.16)] backdrop-blur-xl"
      role="dialog"
      aria-label="Token Usage"
      data-testid="chat-token-usage-popover"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex h-6 w-full items-center gap-2">
        <strong className="min-w-0 flex-1 truncate text-[14px] leading-4">Token Usage</strong>
        <span className="shrink-0 text-[12px] leading-4">{usage.usedContextTokens} / {usage.contextWindowTokens}</span>
      </div>
      <dl className="flex w-full flex-col text-[12px] leading-6">
        <div className="flex h-6 items-center justify-between gap-2"><dt>Input tokens</dt><dd className="text-[13px] font-bold">{usage.inputTokens}</dd></div>
        <div className="flex h-6 items-center justify-between gap-2"><dt>Output tokens</dt><dd className="text-[13px] font-bold">{usage.outputTokens}</dd></div>
        <div className="flex h-6 items-center justify-between gap-2"><dt>Total tokens</dt><dd className="text-[13px] font-bold">{usage.totalTokens}</dd></div>
      </dl>
      <button type="button" className="sr-only" onClick={onClose}>Close token usage</button>
    </div>
  );
}
