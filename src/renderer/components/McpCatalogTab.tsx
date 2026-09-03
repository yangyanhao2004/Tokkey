import { useMemo, useState } from 'react';
import {
  ADD_MCP_LABEL,
  MCP_SCAN_LOADING_TEXT,
  describeEmptyCatalog,
  describeMcpAgentFailure,
  describeMcpScanFailure,
  selectCatalogEntries,
  toMcpCatalogEntries
} from '../pages/agentHubContent';
import { useInstalledMcps } from '../hooks/useInstalledMcps';
import { AddMcpDialog } from './AddMcpDialog';
import { CatalogGrid, CatalogMessage, CatalogTabLayout } from './CatalogTabLayout';
import { ManageMcpDialog } from './ManageMcpDialog';
import { PushButton } from './PushButton';

/**
 * The "MCPs" tab (Figma 225:2405): the servers configured in Claude Code's and
 * Codex's own files, as the main process scanner reads them.
 *
 * A chip is checked exactly when that agent's file already carries the server,
 * so the cards are a reading of those files rather than a list the page keeps.
 * "+ Add MCP" opens the sheet that writes a new server into those same files,
 * after which the grid is whatever the rescan reports.
 */
export function McpCatalogTab() {
  const [query, setQuery] = useState('');
  const [managedMcpId, setManagedMcpId] = useState<string | null>(null);
  const [isAddingMcp, setIsAddingMcp] = useState(false);
  const { servers, failures, isLoading, error, applyAgentSelection, applyConfiguration } =
    useInstalledMcps();

  // Mapping a whole scan is wasted work on every keystroke of the search box.
  const mcpEntries = useMemo(() => toMcpCatalogEntries(servers ?? []), [servers]);
  const entries = selectCatalogEntries(mcpEntries, query);
  // Held by id rather than by object so the dialog follows the rescanned card.
  const managedMcp = servers?.find((mcp) => mcp.id === managedMcpId) ?? null;

  return (
    <>
      <CatalogTabLayout
        query={query}
        onQueryChange={setQuery}
        actions={
          <PushButton onClick={() => setIsAddingMcp(true)} testId="catalog-add-mcp">
            {ADD_MCP_LABEL}
          </PushButton>
        }
      >
        {isLoading && <CatalogMessage testId="catalog-loading">{MCP_SCAN_LOADING_TEXT}</CatalogMessage>}

        {error && (
          <CatalogMessage tone="error" testId="catalog-error">
            {describeMcpScanFailure(error)}
          </CatalogMessage>
        )}

        {/* One unreadable file, reported above the servers the other agent still
            contributed rather than in place of them. */}
        {failures.map((failure) => (
          <CatalogMessage key={failure.agent} tone="error" testId={`catalog-mcp-failure-${failure.agent}`}>
            {describeMcpAgentFailure(failure)}
          </CatalogMessage>
        ))}

        {!isLoading && !error && entries.length === 0 && (
          <CatalogMessage testId="catalog-empty">{describeEmptyCatalog('mcps', query)}</CatalogMessage>
        )}

        <CatalogGrid entries={entries} onAction={setManagedMcpId} />
      </CatalogTabLayout>

      {isAddingMcp && (
        <AddMcpDialog onAdd={applyConfiguration} onClose={() => setIsAddingMcp(false)} />
      )}

      {managedMcp && (
        <ManageMcpDialog
          mcp={managedMcp}
          onApply={(selectedAgents) => applyAgentSelection(managedMcp.id, selectedAgents)}
          onClose={() => setManagedMcpId(null)}
        />
      )}
    </>
  );
}
