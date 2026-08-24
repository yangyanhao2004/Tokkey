import type {
  InstalledMcp,
  McpAgent,
  McpCatalogFailure,
  McpCatalogScan
} from '../shared/types';

type CatalogMode = 'skills' | 'mcps';

const MCP_AGENT_ORDER: readonly McpAgent[] = ['claudeCode', 'codex'];
const MCP_AGENT_LABELS: Record<McpAgent, string> = {
  claudeCode: 'Claude Code',
  codex: 'Codex'
};

/** Owns the observable state and transitions for the Skills & MCPs surface. */
export class SkillsAndMcpsViewModel {
  private readonly scan: () => Promise<McpCatalogScan>;
  private isLoading = false;
  private selectedMode: CatalogMode = 'mcps';
  private searchQuery = '';
  private installedMcps: InstalledMcp[] = [];
  private failures: McpCatalogFailure[] = [];

  constructor(scan: () => Promise<McpCatalogScan>) {
    this.scan = scan;
  }

  get mode(): CatalogMode {
    return this.selectedMode;
  }

  get query(): string {
    return this.searchQuery;
  }

  get loading(): boolean {
    return this.isLoading;
  }

  get catalog(): InstalledMcp[] {
    return [...this.installedMcps];
  }

  get catalogFailures(): McpCatalogFailure[] {
    return [...this.failures];
  }

  selectMode(mode: CatalogMode): Promise<void> {
    if (mode === this.selectedMode) {
      return Promise.resolve();
    }
    this.selectedMode = mode;
    this.searchQuery = '';
    return mode === 'mcps' ? this.loadInstalledMcps() : Promise.resolve();
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
  }

  filteredCatalog(): InstalledMcp[] {
    const normalizedQuery = this.searchQuery.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) {
      return this.catalog;
    }
    return this.catalog.filter((mcp) => mcp.title.toLocaleLowerCase().includes(normalizedQuery));
  }

  refresh(): Promise<void> {
    return this.loadInstalledMcps();
  }

  private async loadInstalledMcps(): Promise<void> {
    if (this.isLoading) {
      return;
    }
    this.isLoading = true;
    try {
      const result = await this.scan();
      this.installedMcps = [...result.servers];
      this.failures = [...result.failures];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures = MCP_AGENT_ORDER.map((agent) => ({ agent, message }));
    } finally {
      this.isLoading = false;
    }
  }
}

/** Renders the local MCP catalog without exposing Electron APIs to the DOM. */
export class RendererApp {
  private readonly rootElement: HTMLElement;
  private readonly viewModel: SkillsAndMcpsViewModel;
  private detailDialog: HTMLDialogElement | null = null;

  constructor() {
    const rootElement = document.getElementById('app');
    if (!(rootElement instanceof HTMLElement)) {
      throw new Error('The application root is missing.');
    }
    this.rootElement = rootElement;
    this.viewModel = new SkillsAndMcpsViewModel(() => window.tokiie.getInstalledMcps());
  }

  /** Loads the selected MCP mode and paints the initial catalog. */
  async start(): Promise<void> {
    await this.viewModel.refresh();
    this.render();
  }

  private render(): void {
    this.rootElement.replaceChildren(this.createPage());
  }

  private createPage(): HTMLElement {
    const page = document.createElement('main');
    page.className = 'app';
    page.append(
      this.createHeader(),
      this.createModeSwitcher(),
      this.viewModel.mode === 'mcps' ? this.createMcpPanel() : this.createSkillsPanel()
    );
    return page;
  }

  private createHeader(): HTMLElement {
    const header = document.createElement('header');
    header.className = 'app__header';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'app__eyebrow';
    eyebrow.textContent = 'Settings';
    const title = document.createElement('h1');
    title.className = 'app__title';
    title.textContent = 'Skills & MCPs';
    const subtitle = document.createElement('p');
    subtitle.className = 'app__subtitle';
    subtitle.textContent = 'Manage the tools available to your agents.';
    header.append(eyebrow, title, subtitle);
    return header;
  }

  private createModeSwitcher(): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'mode-switcher';
    nav.setAttribute('aria-label', 'Settings sections');
    for (const mode of ['skills', 'mcps'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `mode-switcher__button${this.viewModel.mode === mode ? ' mode-switcher__button--selected' : ''}`;
      button.textContent = mode === 'skills' ? 'Skills' : 'MCPs';
      button.setAttribute('aria-pressed', String(this.viewModel.mode === mode));
      button.addEventListener('click', () => {
        void this.viewModel.selectMode(mode).then(() => this.render());
      });
      nav.append(button);
    }
    return nav;
  }

  private createMcpPanel(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'catalog-panel';
    section.append(this.createToolbar(), this.createCatalogContent());
    return section;
  }

  private createToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'catalog-toolbar';
    const searchLabel = document.createElement('label');
    searchLabel.className = 'search-field';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'search-field__icon';
    searchIcon.textContent = '?';
    searchIcon.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search MCPs';
    input.value = this.viewModel.query;
    input.addEventListener('input', () => {
      const selectionStart = input.selectionStart ?? input.value.length;
      this.viewModel.setSearchQuery(input.value);
      this.render();
      const nextInput = this.rootElement.querySelector<HTMLInputElement>('input[type="search"]');
      nextInput?.focus();
      nextInput?.setSelectionRange(selectionStart, selectionStart);
    });
    searchLabel.append(searchIcon, input);
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'button button--secondary';
    refreshButton.textContent = this.viewModel.loading ? 'Scanning...' : 'Refresh';
    refreshButton.disabled = this.viewModel.loading;
    refreshButton.addEventListener('click', () => {
      void this.viewModel.refresh().then(() => this.render());
    });
    toolbar.append(searchLabel, refreshButton);
    return toolbar;
  }

  private createCatalogContent(): HTMLElement {
    const content = document.createElement('div');
    content.className = 'catalog-content';
    const cards = this.viewModel.filteredCatalog();
    if (cards.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'mcp-grid';
      cards.forEach((mcp) => grid.append(this.createMcpCard(mcp)));
      content.append(grid);
    } else {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      const title = document.createElement('h2');
      title.textContent = this.viewModel.query.trim().length > 0 ? 'No matches' : 'No MCPs yet';
      const message = document.createElement('p');
      message.textContent = this.viewModel.query.trim().length > 0
        ? 'Try a different name.'
        : 'Configured MCP servers will appear here.';
      emptyState.append(title, message);
      content.append(emptyState);
    }
    for (const failure of this.viewModel.catalogFailures) {
      const failureRow = document.createElement('p');
      failureRow.className = 'catalog-failure';
      failureRow.textContent = `${MCP_AGENT_LABELS[failure.agent]}: ${failure.message}`;
      content.append(failureRow);
    }
    return content;
  }

  private createMcpCard(mcp: InstalledMcp): HTMLElement {
    const card = document.createElement('article');
    card.className = 'mcp-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.addEventListener('click', () => this.openDetails(mcp));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.openDetails(mcp);
      }
    });
    const heading = document.createElement('h2');
    heading.className = 'mcp-card__title';
    heading.textContent = mcp.title;
    const transport = document.createElement('span');
    transport.className = 'mcp-card__transport';
    transport.textContent = mcp.connectionType === 'streamable_http' ? 'Streamable HTTP' : mcp.connectionType.toUpperCase();
    const badges = document.createElement('div');
    badges.className = 'agent-badges';
    mcp.badges.forEach((badge) => {
      const badgeElement = document.createElement('span');
      badgeElement.className = `agent-badge agent-badge--${badge.state}`;
      badgeElement.textContent = badge.state === 'checked' ? 'OK ' : badge.state === 'disabled' ? '-- ' : '';
      badgeElement.append(document.createTextNode(MCP_AGENT_LABELS[badge.agent]));
      badges.append(badgeElement);
    });
    const manageButton = document.createElement('button');
    manageButton.type = 'button';
    manageButton.className = 'button button--quiet';
    manageButton.textContent = 'Manage';
    manageButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openDetails(mcp);
    });
    const topRow = document.createElement('div');
    topRow.className = 'mcp-card__top-row';
    topRow.append(heading, manageButton);
    card.append(topRow, transport, badges);
    return card;
  }

  private openDetails(mcp: InstalledMcp): void {
    this.detailDialog?.remove();
    const dialog = document.createElement('dialog');
    dialog.className = 'detail-dialog';
    const header = document.createElement('div');
    header.className = 'detail-dialog__header';
    const title = document.createElement('h2');
    title.textContent = mcp.title;
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'button button--quiet';
    closeButton.textContent = 'Close';
    closeButton.addEventListener('click', () => dialog.close());
    header.append(title, closeButton);
    const description = document.createElement('p');
    description.className = 'detail-dialog__meta';
    description.textContent = `${mcp.connectionType === 'streamable_http' ? 'Streamable HTTP' : mcp.connectionType.toUpperCase()} · ${mcp.agents.map((agent) => MCP_AGENT_LABELS[agent]).join(', ')}`;
    const pre = document.createElement('pre');
    pre.className = 'detail-dialog__definition';
    pre.textContent = mcp.definition;
    dialog.append(header, description, pre);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.append(dialog);
    this.detailDialog = dialog;
    dialog.showModal();
  }

  private createSkillsPanel(): HTMLElement {
    const panel = document.createElement('section');
    panel.className = 'skills-placeholder';
    const title = document.createElement('h2');
    title.textContent = 'Skills';
    const message = document.createElement('p');
    message.textContent = 'Skill discovery and installation are available from the Skills section.';
    panel.append(title, message);
    return panel;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void new RendererApp().start();
});
