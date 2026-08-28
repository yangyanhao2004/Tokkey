import type { InstalledMcp, McpAgent } from '../../shared/types';
import { MANAGE_MCP_DIALOG_EYEBROW, readUnsupportedAgents } from '../pages/agentHubContent';
import { ManageAgentsDialog } from './ManageAgentsDialog';

export interface ManageMcpDialogProps {
  mcp: InstalledMcp;
  /** Writes the server into exactly these agents' configuration files. */
  onApply: (selectedAgents: McpAgent[]) => Promise<void>;
  onClose: () => void;
}

/**
 * "Manage MCP": which agents this server is configured for.
 *
 * Unlike the skill dialog there is nothing further to read — the scan the cards
 * are drawn from already says which files carry the server, and that is the
 * whole selection. Codex cannot run an SSE server, so that box is locked rather
 * than offering a save the applier would refuse.
 *
 * There is no uninstall button: an MCP is only ever an entry in the agents'
 * own files, so clearing the boxes and saving already removes it everywhere.
 */
export function ManageMcpDialog({ mcp, onApply, onClose }: ManageMcpDialogProps) {
  return (
    <ManageAgentsDialog
      eyebrow={MANAGE_MCP_DIALOG_EYEBROW}
      name={mcp.title}
      currentAgents={mcp.agents}
      unsupportedAgents={readUnsupportedAgents(mcp.badges)}
      onApply={onApply}
      onClose={onClose}
      testId="manage-mcp"
    />
  );
}
