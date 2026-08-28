import { useState } from 'react';
import {
  ADD_MCP_LABEL,
  MCP_CATALOG,
  describeEmptyCatalog,
  selectCatalogEntries,
  type AgentAvailability
} from '../pages/agentHubContent';
import { CatalogGrid, CatalogMessage, CatalogTabLayout } from './CatalogTabLayout';
import { PushButton } from './PushButton';

export interface McpCatalogTabProps {
  availability: AgentAvailability;
}

/**
 * The "MCPs" tab (Figma 225:2405). Its entries are still fixed content, so
 * nothing here scans or installs: "+ Add MCP" is drawn for the layout the
 * design asks for and does nothing until the Add MCP dialog exists.
 */
export function McpCatalogTab({ availability }: McpCatalogTabProps) {
  const [query, setQuery] = useState('');
  const entries = selectCatalogEntries(MCP_CATALOG, query);

  return (
    <CatalogTabLayout
      query={query}
      onQueryChange={setQuery}
      actions={<PushButton testId="catalog-add-mcp">{ADD_MCP_LABEL}</PushButton>}
    >
      {entries.length === 0 && (
        <CatalogMessage testId="catalog-empty">{describeEmptyCatalog('mcps', query)}</CatalogMessage>
      )}

      {/* No `onAction`: an MCP entry has nothing to manage yet, which is what
          leaves its Manage button disabled. */}
      <CatalogGrid entries={entries} availability={availability} />
    </CatalogTabLayout>
  );
}
