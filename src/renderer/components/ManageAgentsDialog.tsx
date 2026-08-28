import { useCallback, useEffect, useState } from 'react';
import {
  CANCEL_LABEL,
  HUB_AGENTS,
  MANAGE_DIALOG_COMPATIBLE_LABEL,
  MANAGE_DIALOG_ENABLE_HEADING,
  MANAGE_DIALOG_ENABLE_HINT,
  MANAGE_DIALOG_LOADING_TEXT,
  MANAGE_DIALOG_UNSUPPORTED_LABEL,
  SAVE_LABEL,
  UNINSTALL_LABEL,
  describeManageFailure,
  describeSelectedAgentCount,
  type CatalogAgent,
  type HubAgent
} from '../pages/agentHubContent';
import { AgentMarkTile } from './AgentMark';
import { PushButton } from './PushButton';

interface AgentToggleProps {
  agent: HubAgent;
  isSelected: boolean;
  disabled: boolean;
  /** Said under the agent's name: whether it could load this entry at all. */
  supportLabel: string;
  onToggle: (agent: CatalogAgent) => void;
}

/**
 * One agent the entry can be enabled for. The whole card is the control, so
 * the 12px box at its end is decoration the button state drives rather than a
 * second thing to click.
 */
function AgentToggle({ agent, isSelected, disabled, supportLabel, onToggle }: AgentToggleProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isSelected}
      disabled={disabled}
      onClick={() => onToggle(agent.catalogAgent)}
      className={`flex min-w-0 flex-1 items-center justify-between rounded-[8px] border px-2 py-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40 ${
        isSelected
          ? 'border-toggle-selected-border bg-toggle-selected-bg'
          : 'border-toggle-border bg-toggle-bg'
      }`}
      data-testid={`manage-agent-${agent.id}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <AgentMarkTile agentId={agent.id} size="sm" />
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <span className="truncate text-[10px] leading-[12px] font-bold text-text-primary">
            {agent.name}
          </span>
          <span className="text-[8px] leading-[10px] text-dialog-eyebrow">{supportLabel}</span>
        </span>
      </span>

      <span
        className={`flex size-[12px] shrink-0 items-center justify-center rounded-[6px] text-[8px] leading-[10px] font-semibold text-white ${
          isSelected ? 'bg-toggle-check-on' : 'bg-toggle-check-off'
        }`}
        aria-hidden
      >
        {isSelected ? '✓' : ''}
      </span>
    </button>
  );
}

export interface ManageAgentsDialogProps {
  /** The small line above the title, e.g. "MANAGE SKILL". */
  eyebrow: string;
  /** The entry's name, which is what the dialog is titled after. */
  name: string;
  /** The agents the entry is enabled for now, or `null` until that is known. */
  currentAgents: readonly CatalogAgent[] | null;
  /** Agents that cannot load this entry at all, which cannot be toggled on. */
  unsupportedAgents?: readonly CatalogAgent[];
  /** Reported in place of the dialog's own errors when the reading itself failed. */
  readError?: string | null;
  /** Enables the entry for exactly these agents; rejects when the write refuses. */
  onApply: (selectedAgents: CatalogAgent[]) => Promise<void>;
  /** Omitted when there is nothing installed to remove, which hides the button. */
  onUninstall?: () => Promise<void>;
  onClose: () => void;
  /** What the confirming button says; installing from a repository says "Install". */
  applyLabel?: string;
  /** Distinguishes one dialog's elements from another's, e.g. "manage-skill". */
  testId: string;
}

/**
 * The dialog behind a catalog card's "Manage" button (Figma 225:1301): which
 * agents the entry is enabled for, saved as one complete selection, plus the
 * uninstall that removes it everywhere.
 *
 * It holds no opinion about what is being managed — a skill's deployment and an
 * MCP's configuration entries are the same question, "which agents load this",
 * so both ask it with this one dialog and differ only in the eyebrow above the
 * name and in what their Save actually writes.
 */
export function ManageAgentsDialog({
  eyebrow,
  name,
  currentAgents,
  unsupportedAgents = [],
  readError = null,
  onApply,
  onUninstall,
  onClose,
  applyLabel = SAVE_LABEL,
  testId
}: ManageAgentsDialogProps) {
  const [selection, setSelection] = useState<Set<CatalogAgent> | null>(null);
  const [pendingAction, setPendingAction] = useState<'save' | 'uninstall' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The reading is the starting point; edits afterwards belong to the dialog.
  useEffect(() => {
    if (currentAgents) {
      setSelection(new Set(currentAgents));
    }
  }, [currentAgents]);

  // Escape closes, as every dialog on this platform does.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const toggleAgent = useCallback((agent: CatalogAgent) => {
    setSelection((current) => {
      if (!current) {
        return current;
      }
      const next = new Set(current);
      if (next.has(agent)) {
        next.delete(agent);
      } else {
        next.add(agent);
      }
      return next;
    });
  }, []);

  /** Runs one write, keeping the dialog open when it fails. */
  const run = useCallback(
    async (action: 'save' | 'uninstall', call: () => Promise<void>) => {
      setPendingAction(action);
      setActionError(null);
      try {
        await call();
        onClose();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause));
        setPendingAction(null);
      }
    },
    [onClose]
  );

  const isBusy = pendingAction !== null;
  const message = actionError ?? readError;

  return (
    // A full-window scrim: the dialog belongs to the app, not to the page under it.
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6"
      onClick={onClose}
      data-testid={`${testId}-backdrop`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Manage ${name}`}
        // The backdrop closes on click, so the dialog must not pass its own through.
        onClick={(event) => event.stopPropagation()}
        className="flex w-[482px] max-w-full flex-col overflow-hidden rounded-[12px] border-[0.829px] border-dialog-border bg-white shadow-[0px_18.245px_58.053px_0px_rgba(18,18,17,0.16)]"
        data-testid={`${testId}-dialog`}
      >
        <div className="flex w-full items-center gap-2.5 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-fill-tile text-[16px] leading-none text-dialog-eyebrow">
            ✦
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[10px] leading-[12px] text-dialog-eyebrow">{eyebrow}</span>
            <h2 className="truncate text-[14px] leading-[17px] font-bold text-text-primary">
              {name}
            </h2>
          </div>
        </div>

        <span className="h-[0.415px] w-full shrink-0 bg-dialog-divider" />

        <div className="flex w-full flex-col gap-3 p-4">
          <div className="flex w-full items-center justify-between gap-2 text-[10px] leading-[12px] text-text-primary">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-bold">{MANAGE_DIALOG_ENABLE_HEADING}</span>
              <span>{MANAGE_DIALOG_ENABLE_HINT}</span>
            </div>
            <span className="shrink-0" data-testid="manage-selected-count">
              {selection ? describeSelectedAgentCount(selection.size) : MANAGE_DIALOG_LOADING_TEXT}
            </span>
          </div>

          <div className="flex w-full items-start gap-2">
            {HUB_AGENTS.map((agent) => {
              const isUnsupported = unsupportedAgents.includes(agent.catalogAgent);
              return (
                <AgentToggle
                  key={agent.id}
                  agent={agent}
                  isSelected={selection?.has(agent.catalogAgent) === true}
                  // Nothing may be toggled before the current selection is known,
                  // and an agent that cannot load this entry never may.
                  disabled={selection === null || isBusy || isUnsupported}
                  supportLabel={
                    isUnsupported ? MANAGE_DIALOG_UNSUPPORTED_LABEL : MANAGE_DIALOG_COMPATIBLE_LABEL
                  }
                  onToggle={toggleAgent}
                />
              );
            })}
          </div>

          {message && (
            <p className="w-full text-[10px] leading-[12px] text-text-secondary" data-testid={`${testId}-error`}>
              {describeManageFailure(message)}
            </p>
          )}
        </div>

        <div className="flex w-full items-center justify-between border-t-[0.415px] border-separator-hairline bg-white p-4">
          {/* An empty span rather than nothing, so the buttons opposite it stay
              at the dialog's right edge when there is nothing to uninstall. */}
          {onUninstall ? (
            <PushButton
              variant="plain"
              disabled={isBusy}
              onClick={() => void run('uninstall', onUninstall)}
              testId="manage-uninstall"
            >
              {UNINSTALL_LABEL}
            </PushButton>
          ) : (
            <span />
          )}

          <div className="flex shrink-0 items-center gap-2">
            <PushButton variant="tinted" disabled={isBusy} onClick={onClose} testId="manage-cancel">
              {CANCEL_LABEL}
            </PushButton>
            <PushButton
              disabled={selection === null || isBusy}
              onClick={() => void run('save', () => onApply([...(selection ?? [])]))}
              testId="manage-save"
            >
              {applyLabel}
            </PushButton>
          </div>
        </div>
      </div>
    </div>
  );
}
