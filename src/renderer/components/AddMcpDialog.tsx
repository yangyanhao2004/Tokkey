import { useCallback, useEffect, useMemo, useState } from 'react';
import { McpAgentCompatibility } from '../../shared/McpConfiguration';
import type {
  McpAgent,
  McpConfigurationDraft,
  McpConnectionType,
  McpWizardDraft
} from '../../shared/types';
import {
  ADD_MCP_AVAILABLE_HEADING,
  ADD_MCP_BUSY_LABEL,
  ADD_MCP_CONFIRM_LABEL,
  ADD_MCP_DIALOG_TITLE,
  ADD_MCP_MODES,
  ADD_MCP_MODE_LABEL,
  CANCEL_LABEL,
  HUB_AGENTS,
  ICON_BASE_PATH,
  MANAGE_DIALOG_ENABLE_HINT,
  MCP_COMMAND_FIELD_LABEL,
  MCP_COMMAND_PLACEHOLDER,
  MCP_CONNECTION_FIELD_LABEL,
  MCP_CONNECTION_OPTIONS,
  MCP_ENVIRONMENT_FIELD_LABEL,
  MCP_ENVIRONMENT_PLACEHOLDER,
  MCP_FORMAT_LABEL,
  MCP_JSON_FIELD_LABEL,
  MCP_JSON_PLACEHOLDER,
  MCP_JSON_VALID_TEXT,
  MCP_NAME_FIELD_LABEL,
  MCP_NAME_PLACEHOLDER,
  MCP_URL_FIELD_LABEL,
  MCP_URL_PLACEHOLDER,
  MCP_VALIDATE_LABEL,
  describeAgentSupport,
  describeMcpAddFailure,
  describeMcpBlockingReason,
  describeSelectedAgentCount,
  readUnavailableAgents,
  type CatalogAgent,
  type CatalogNotice,
  type McpEditorMode
} from '../pages/agentHubContent';
import { useAgentAvailability } from './AgentDetectionProvider';
import { AgentToggle } from './AgentToggle';
import { PushButton } from './PushButton';
import { SegmentedControl } from './SegmentedControl';

/** The one place that decides whether an agent can reach a transport at all. */
const AGENT_COMPATIBILITY = new McpAgentCompatibility();

/** How many spaces "Format" re-indents the JSON editor with. */
const JSON_INDENT_WIDTH = 2;

/** An untouched wizard: no name, and a command server, which most MCPs are. */
const EMPTY_WIZARD_DRAFT: McpWizardDraft = {
  mode: 'wizard',
  name: '',
  connectionType: 'stdio',
  commandLine: '',
  environmentText: '',
  url: ''
};

/** The filled box the dialog types into, shared by every field on the sheet. */
const FIELD_CLASSES =
  'w-full select-text rounded-[8px] bg-field-bg p-2 text-[10px] leading-[12px] text-text-primary outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary disabled:opacity-40 placeholder:text-field-placeholder';

const FIELD_LABEL_CLASSES = 'text-[10px] leading-[12px] font-bold text-text-primary';

interface DialogTextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  /** Only the field the dialog opens on takes focus. */
  autoFocus?: boolean;
  testId: string;
}

/** One labelled text field, filled rather than outlined as the design draws it. */
function DialogTextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus = false,
  testId
}: DialogTextFieldProps) {
  return (
    <label className="flex min-w-0 flex-1 flex-col items-start gap-1">
      <span className={FIELD_LABEL_CLASSES}>{label}</span>
      <input
        className={FIELD_CLASSES}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        data-testid={testId}
      />
    </label>
  );
}

interface DialogSelectFieldProps<TValue extends string> {
  label: string;
  value: TValue;
  options: readonly { value: TValue; label: string }[];
  onChange: (value: TValue) => void;
  disabled: boolean;
  testId: string;
}

/**
 * The pop-up button in a field's clothing (Figma "Pop-Up Button" inside the
 * wizard's two-column row). A transparent native `<select>` covers the chip, so
 * the menu and its keyboard handling come from the platform — the same trick
 * `PopUpButton` uses, drawn in the field's fill so the column it shares with
 * "Name" lines up.
 */
function DialogSelectField<TValue extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  testId
}: DialogSelectFieldProps<TValue>) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? '';

  return (
    <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
      <span className={FIELD_LABEL_CLASSES}>{label}</span>
      <div
        className={`relative flex items-center justify-between gap-2 ${FIELD_CLASSES} ${
          disabled ? 'opacity-40' : ''
        }`}
      >
        <span className="truncate">{selectedLabel}</span>
        <img
          className="block h-[12px] w-[8px] max-w-none shrink-0"
          src={`${ICON_BASE_PATH}/main-chevron-up-down.svg`}
          alt=""
        />
        <select
          className="absolute inset-0 size-full cursor-default appearance-none opacity-0 outline-none"
          value={value}
          onChange={(event) => onChange(event.target.value as TValue)}
          disabled={disabled}
          aria-label={label}
          data-testid={testId}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export interface AddMcpDialogProps {
  /**
   * Writes the canonical one-server envelope into exactly `selectedAgents`;
   * rejects when a configuration file refuses it, which is what holds the sheet
   * open over the draft that produced it.
   */
  onAdd: (configurationJson: string, selectedAgents: McpAgent[]) => Promise<void>;
  onClose: () => void;
}

/**
 * The sheet behind the MCPs tab's "+ Add MCP" button (Figma 531:2979 and
 * 531:3240): one server described either through guided fields or as the raw
 * JSON envelope, and the agents to write it for.
 *
 * Both editors are kept alive at once, so switching modes never costs what was
 * typed in the other. Everything the sheet knows about a draft comes from the
 * shared preparer over IPC — the same conversion the write itself performs —
 * so the button is enabled by exactly what the filesystem will accept.
 *
 * Nothing is written until "Add MCP" is pressed: opening the sheet, switching
 * modes, formatting and validating all stay in memory.
 */
export function AddMcpDialog({ onAdd, onClose }: AddMcpDialogProps) {
  const [mode, setMode] = useState<McpEditorMode>('wizard');
  const [wizard, setWizard] = useState<McpWizardDraft>(EMPTY_WIZARD_DRAFT);
  const [jsonText, setJsonText] = useState('');
  // Everything supported starts selected; the effects below drop what this
  // machine or this transport cannot take, and never put it back.
  const [selection, setSelection] = useState<Set<CatalogAgent>>(
    () => new Set(HUB_AGENTS.map((agent) => agent.catalogAgent))
  );
  const [isApplying, setIsApplying] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // What "Validate" last said. Editing anything clears it, since it describes
  // a draft that no longer exists.
  const [notice, setNotice] = useState<CatalogNotice | null>(null);
  // Guidance is held back until something has been typed, so a sheet that has
  // only just opened does not open by complaining about an empty name.
  const [isDirty, setIsDirty] = useState(false);

  const availability = useAgentAvailability();
  const unavailableAgents = useMemo(() => readUnavailableAgents(availability), [availability]);

  const draft: McpConfigurationDraft = useMemo(
    () => (mode === 'wizard' ? wizard : { mode: 'json', jsonText }),
    [mode, wizard, jsonText]
  );

  // The main process owns the conversion, so the sheet asks it rather than
  // keeping a second opinion about what a valid server is.
  const preparation = useMemo(() => window.tokkey.prepareMcpConfiguration(draft), [draft]);

  /**
   * The transport being described: chosen outright in the wizard, and in JSON
   * mode whatever the text currently decodes to — unknown while it decodes to
   * nothing, which locks no agent out.
   */
  const connectionType: McpConnectionType | null =
    mode === 'wizard' ? wizard.connectionType : preparation.configuration?.connectionType ?? null;

  // Escape closes, as every dialog on this platform does — but not mid-write,
  // when there is a filesystem change already in flight.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isApplying) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isApplying, onClose]);

  /** Drops agents the current draft has put out of reach, keeping the rest. */
  const retainSelectable = useCallback((isRetained: (agent: CatalogAgent) => boolean) => {
    setSelection((current) => {
      const next = new Set([...current].filter(isRetained));
      // Same set, same object: an unchanged selection must not re-render.
      return next.size === current.size ? current : next;
    });
  }, []);

  // A transport Codex cannot speak deselects Codex, and switching back does not
  // re-select it: the selection is the user's, and this only ever narrows it.
  useEffect(() => {
    if (!connectionType) {
      return;
    }
    retainSelectable((agent) => AGENT_COMPATIBILITY.supports(agent, connectionType));
  }, [connectionType, retainSelectable]);

  // Writing configuration for a CLI that is not on this machine leaves a file
  // nothing will ever read, so detection narrows the selection the same way.
  useEffect(() => {
    if (unavailableAgents.length === 0) {
      return;
    }
    retainSelectable((agent) => !unavailableAgents.includes(agent));
  }, [retainSelectable, unavailableAgents]);

  /** Every edit invalidates whatever the sheet last said about the old draft. */
  const beginEdit = useCallback(() => {
    setIsDirty(true);
    setSubmitError(null);
    setNotice(null);
  }, []);

  const editWizard = useCallback(
    (change: Partial<McpWizardDraft>) => {
      beginEdit();
      setWizard((current) => ({ ...current, ...change }));
    },
    [beginEdit]
  );

  const editJson = useCallback(
    (text: string) => {
      beginEdit();
      setJsonText(text);
    },
    [beginEdit]
  );

  const toggleAgent = useCallback(
    (agent: CatalogAgent) => {
      beginEdit();
      setSelection((current) => {
        const next = new Set(current);
        if (next.has(agent)) {
          next.delete(agent);
        } else {
          next.add(agent);
        }
        return next;
      });
    },
    [beginEdit]
  );

  /** Re-indents whatever parses as JSON, and leaves the rest exactly as typed. */
  const formatJson = useCallback(() => {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      beginEdit();
      setJsonText(JSON.stringify(parsed, null, JSON_INDENT_WIDTH));
    } catch (cause) {
      setNotice({ tone: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [beginEdit, jsonText]);

  /** Says what the draft is, and changes nothing else — the write validates again. */
  const validateJson = useCallback(() => {
    setSubmitError(null);
    setNotice(
      preparation.isValid
        ? { tone: 'neutral', message: MCP_JSON_VALID_TEXT }
        : { tone: 'error', message: preparation.error ?? '' }
    );
  }, [preparation]);

  const selectedAgents = useMemo(() => [...selection], [selection]);
  const unsupportedSelectedAgents = connectionType
    ? selectedAgents.filter((agent) => !AGENT_COMPATIBILITY.supports(agent, connectionType))
    : [];
  const blockingReason = describeMcpBlockingReason(
    selectedAgents.length > 0,
    preparation.error,
    unsupportedSelectedAgents
  );
  const canSubmit = blockingReason === null && !isApplying;

  /** Writes the server, keeping the sheet and its draft standing when it fails. */
  const submit = useCallback(async () => {
    if (isApplying) {
      return;
    }
    // Converted once more at the moment of confirming, so what reaches the
    // filesystem can never be a reading taken before the last keystroke.
    const confirmed = window.tokkey.prepareMcpConfiguration(draft);
    if (!confirmed.canonicalJson) {
      setNotice(null);
      setSubmitError(confirmed.error);
      return;
    }

    setIsApplying(true);
    setSubmitError(null);
    setNotice(null);
    try {
      await onAdd(confirmed.canonicalJson, [...selection]);
      onClose();
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
      setIsApplying(false);
    }
  }, [draft, isApplying, onAdd, onClose, selection]);

  const message: CatalogNotice | null =
    (submitError === null ? null : describeMcpAddFailure(submitError)) ??
    notice ??
    (isDirty && blockingReason ? { tone: 'neutral', message: blockingReason } : null);

  return (
    // A full-window scrim: the dialog belongs to the app, not to the page under it.
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6"
      onClick={() => {
        if (!isApplying) {
          onClose();
        }
      }}
      data-testid="add-mcp-backdrop"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={ADD_MCP_DIALOG_TITLE}
        // The backdrop closes on click, so the dialog must not pass its own through.
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex w-[482px] max-w-full flex-col overflow-hidden rounded-[12px] border-[0.829px] border-dialog-border bg-white shadow-[0px_18.245px_58.053px_0px_rgba(18,18,17,0.16)]"
        data-testid="add-mcp-dialog"
      >
        <div className="flex w-full items-center justify-between gap-2 p-4">
          <h2 className="truncate text-[14px] leading-[17px] font-bold text-text-primary">
            {ADD_MCP_DIALOG_TITLE}
          </h2>
          <SegmentedControl
            options={ADD_MCP_MODES}
            value={mode}
            onChange={setMode}
            label={ADD_MCP_MODE_LABEL}
            testId="add-mcp-mode"
          />
        </div>

        <span className="h-[0.415px] w-full shrink-0 bg-dialog-divider" />

        <div className="flex w-full flex-col gap-3 p-4">
          {mode === 'wizard' ? (
            <>
              <div className="flex w-full items-start gap-3">
                <DialogTextField
                  label={MCP_NAME_FIELD_LABEL}
                  value={wizard.name}
                  onChange={(name) => editWizard({ name })}
                  placeholder={MCP_NAME_PLACEHOLDER}
                  disabled={isApplying}
                  autoFocus
                  testId="add-mcp-name"
                />
                <DialogSelectField
                  label={MCP_CONNECTION_FIELD_LABEL}
                  value={wizard.connectionType}
                  options={MCP_CONNECTION_OPTIONS}
                  onChange={(connection) => editWizard({ connectionType: connection })}
                  disabled={isApplying}
                  testId="add-mcp-connection-type"
                />
              </div>

              {/* A command server is launched; a remote one is dialled. The
                  field the other mode would need keeps whatever was typed in
                  it, so switching back and forth costs nothing. */}
              {wizard.connectionType === 'stdio' ? (
                <>
                  <DialogTextField
                    label={MCP_COMMAND_FIELD_LABEL}
                    value={wizard.commandLine}
                    onChange={(commandLine) => editWizard({ commandLine })}
                    placeholder={MCP_COMMAND_PLACEHOLDER}
                    disabled={isApplying}
                    testId="add-mcp-command"
                  />
                  <DialogTextField
                    label={MCP_ENVIRONMENT_FIELD_LABEL}
                    value={wizard.environmentText}
                    onChange={(environmentText) => editWizard({ environmentText })}
                    placeholder={MCP_ENVIRONMENT_PLACEHOLDER}
                    disabled={isApplying}
                    testId="add-mcp-environment"
                  />
                </>
              ) : (
                <DialogTextField
                  label={MCP_URL_FIELD_LABEL}
                  value={wizard.url}
                  onChange={(url) => editWizard({ url })}
                  placeholder={MCP_URL_PLACEHOLDER}
                  disabled={isApplying}
                  testId="add-mcp-url"
                />
              )}
            </>
          ) : (
            <div className="flex w-full flex-col items-start gap-2">
              <label className="flex w-full flex-col items-start gap-2">
                <span className={FIELD_LABEL_CLASSES}>{MCP_JSON_FIELD_LABEL}</span>
                <textarea
                  className="h-[144px] w-full select-text resize-none rounded-[6px] bg-white px-3 py-1 font-mono text-[10px] leading-[16px] text-text-primary shadow-[0px_0px_0px_1px_rgba(0,0,0,0.08)] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary disabled:opacity-40 placeholder:text-field-placeholder"
                  value={jsonText}
                  onChange={(event) => editJson(event.target.value)}
                  placeholder={MCP_JSON_PLACEHOLDER}
                  disabled={isApplying}
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                  data-testid="add-mcp-json"
                />
              </label>

              <div className="flex items-center gap-2">
                <PushButton
                  variant="tinted"
                  disabled={isApplying}
                  onClick={formatJson}
                  testId="add-mcp-format"
                >
                  {MCP_FORMAT_LABEL}
                </PushButton>
                <PushButton
                  variant="tinted"
                  disabled={isApplying}
                  onClick={validateJson}
                  testId="add-mcp-validate"
                >
                  {MCP_VALIDATE_LABEL}
                </PushButton>
              </div>
            </div>
          )}

          <div className="flex w-full items-center justify-between gap-2 text-[10px] leading-[12px] text-text-primary">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-bold">{ADD_MCP_AVAILABLE_HEADING}</span>
              {/* The wizard explains the row; the JSON editor, whose own field
                  is already the tall one on the sheet, does not. */}
              {mode === 'wizard' && <span>{MANAGE_DIALOG_ENABLE_HINT}</span>}
            </div>
            <span className="shrink-0" data-testid="add-mcp-selected-count">
              {describeSelectedAgentCount(selection.size)}
            </span>
          </div>

          <div className="flex w-full items-start gap-2">
            {HUB_AGENTS.map((agent) => {
              const isUnsupported =
                connectionType !== null &&
                !AGENT_COMPATIBILITY.supports(agent.catalogAgent, connectionType);
              const isUnavailable = unavailableAgents.includes(agent.catalogAgent);
              return (
                <AgentToggle
                  key={agent.id}
                  agent={agent}
                  isSelected={selection.has(agent.catalogAgent)}
                  disabled={isApplying || isUnsupported || isUnavailable}
                  supportLabel={describeAgentSupport(isUnsupported, isUnavailable)}
                  onToggle={toggleAgent}
                  testIdPrefix="add-mcp-agent"
                />
              );
            })}
          </div>

          {message && (
            <p
              className={`w-full text-[10px] leading-[12px] ${
                message.tone === 'error' ? 'text-status-error-text' : 'text-text-secondary'
              }`}
              data-testid="add-mcp-message"
            >
              {message.message}
            </p>
          )}
        </div>

        <div className="flex w-full items-center justify-end gap-2 border-t-[0.415px] border-separator-hairline bg-white p-4">
          <PushButton variant="tinted" disabled={isApplying} onClick={onClose} testId="add-mcp-cancel">
            {CANCEL_LABEL}
          </PushButton>
          <PushButton disabled={!canSubmit} onClick={() => void submit()} testId="add-mcp-confirm">
            {isApplying ? ADD_MCP_BUSY_LABEL : ADD_MCP_CONFIRM_LABEL}
          </PushButton>
        </div>
      </form>
    </div>
  );
}
