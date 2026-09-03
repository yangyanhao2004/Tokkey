import { useCallback, useEffect, useState } from 'react';
import {
  CANCEL_LABEL,
  HUB_AGENTS,
  MANAGE_DIALOG_ENABLE_HEADING,
  MANAGE_DIALOG_ENABLE_HINT,
  MANAGE_DIALOG_LOADING_TEXT,
  SAVE_LABEL,
  UNINSTALL_LABEL,
  describeAgentSupport,
  describeManageFailure,
  describeSelectedAgentCount,
  readUnavailableAgents,
  type CatalogAgent
} from '../pages/agentHubContent';
import { useAgentAvailability } from './AgentDetectionProvider';
import { AgentToggle } from './AgentToggle';
import { ConfirmDialog } from './ConfirmDialog';
import { PushButton } from './PushButton';

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
  /**
   * What the confirmation in front of Uninstall asks. The dialog does not know
   * what it is removing, so the caller that owns the button owns its wording;
   * without it Uninstall runs on the first click.
   */
  uninstallConfirm?: { title: string; message: string };
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
 *
 * Two things lock a toggle: an entry the agent cannot load, and an agent this
 * machine does not have. The second comes from the shared detection rather than
 * from a prop, so the dialog can never allow what the card behind it greyed out.
 */
export function ManageAgentsDialog({
  eyebrow,
  name,
  currentAgents,
  unsupportedAgents = [],
  readError = null,
  onApply,
  onUninstall,
  uninstallConfirm,
  onClose,
  applyLabel = SAVE_LABEL,
  testId
}: ManageAgentsDialogProps) {
  const [selection, setSelection] = useState<Set<CatalogAgent> | null>(null);
  const [pendingAction, setPendingAction] = useState<'save' | 'uninstall' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isConfirmingUninstall, setIsConfirmingUninstall] = useState(false);
  const availability = useAgentAvailability();

  // The reading is the starting point; edits afterwards belong to the dialog.
  useEffect(() => {
    if (currentAgents) {
      setSelection(new Set(currentAgents));
    }
  }, [currentAgents]);

  // Escape closes, as every dialog on this platform does — but it belongs to the
  // confirmation while that is up, which answers it without closing this dialog.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isConfirmingUninstall) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isConfirmingUninstall]);

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
  const unavailableAgents = readUnavailableAgents(availability);

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
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-fill-tile text-[16px] leading-none text-label-eyebrow">
            ✦
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[10px] leading-[12px] text-label-eyebrow">{eyebrow}</span>
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
              const isUnavailable = unavailableAgents.includes(agent.catalogAgent);
              return (
                <AgentToggle
                  key={agent.id}
                  agent={agent}
                  isSelected={selection?.has(agent.catalogAgent) === true}
                  // Nothing may be toggled before the current selection is known,
                  // and neither an agent that cannot load this entry nor one that
                  // is not on this machine ever may.
                  disabled={selection === null || isBusy || isUnsupported || isUnavailable}
                  supportLabel={describeAgentSupport(isUnsupported, isUnavailable)}
                  onToggle={toggleAgent}
                  testIdPrefix="manage-agent"
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
              onClick={() => {
                if (uninstallConfirm) {
                  setIsConfirmingUninstall(true);
                  return;
                }
                void run('uninstall', onUninstall);
              }}
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

      {/* Answering it leaves the manage dialog standing, so a refused uninstall
          still reports itself where the button that started it lives. */}
      {isConfirmingUninstall && uninstallConfirm && onUninstall && (
        <ConfirmDialog
          title={uninstallConfirm.title}
          message={uninstallConfirm.message}
          confirmLabel={UNINSTALL_LABEL}
          onConfirm={() => {
            setIsConfirmingUninstall(false);
            void run('uninstall', onUninstall);
          }}
          onCancel={() => setIsConfirmingUninstall(false)}
          testId={`${testId}-uninstall-confirm`}
        />
      )}
    </div>
  );
}
