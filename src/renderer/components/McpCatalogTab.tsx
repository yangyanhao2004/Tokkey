import { useState } from 'react';
import {
  MCP_CATALOG,
  describeDiscoverAction,
  describeEmptyCatalog,
  describeUploadAction,
  selectCatalogEntries,
  type AgentAvailability
} from '../pages/agentHubContent';
import { CatalogGrid, CatalogMessage, CatalogTabLayout } from './CatalogTabLayout';
import { PushButton } from './PushButton';

export interface McpCatalogTabProps {
  availability: AgentAvailability;
}

/**
 * The "MCPs" tab. Its entries are still fixed content, so nothing here scans or
 * installs: the buttons are drawn for the layout the design asks for and do
 * nothing until an MCP catalog backs them.
 */
export function McpCatalogTab({ availability }: McpCatalogTabProps) {
  const [query, setQuery] = useState('');
  const entries = selectCatalogEntries(MCP_CATALOG, query);

  return (
    <CatalogTabLayout
      query={query}
      onQueryChange={setQuery}
      actions={
        <>
          <PushButton variant="tinted" testId="catalog-upload">
            {describeUploadAction('mcps')}
          </PushButton>
          <PushButton testId="catalog-discover">{describeDiscoverAction('mcps')}</PushButton>
        </>
      }
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
