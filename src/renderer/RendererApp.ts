type McpCatalogScan = Awaited<ReturnType<Window['tokiie']['getInstalledMcps']>>;
type InstalledMcp = McpCatalogScan['servers'][number];
type McpAgent = InstalledMcp['agents'][number];
type McpConnectionType = InstalledMcp['connectionType'];
type McpConfigurationDraft = Parameters<Window['tokiie']['prepareMcpConfiguration']>[0];
type McpConfigurationPreparation = ReturnType<Window['tokiie']['prepareMcpConfiguration']>;
type ApplyMcpConfigurationRequest = Parameters<Window['tokiie']['applyMcpConfiguration']>[0];
type CatalogMode = 'skills' | 'mcps';
type McpEditorMode = 'wizard' | 'json';

const MCP_AGENT_ORDER: readonly McpAgent[] = ['claudeCode', 'hermes', 'codex'];
const MCP_AGENT_LABELS: Record<McpAgent, string> = {
  claudeCode: 'Claude Code',
  hermes: 'Hermes',
  codex: 'Codex'
};
const MCP_CONNECTION_LABELS: Record<McpConnectionType, string> = {
  stdio: 'Stdio',
  streamable_http: 'Streamable HTTP',
  sse: 'SSE'
};
const MCP_EXAMPLES: Record<McpConnectionType, string> = {
  stdio: JSON.stringify({
    mcpServers: {
      'example-server': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-example'],
        env: {}
      }
    }
  }, null, 2),
  streamable_http: JSON.stringify({
    mcpServers: {
      'example-server': {
        type: 'streamable_http',
        url: 'https://example.com/mcp'
      }
    }
  }, null, 2),
  sse: JSON.stringify({
    mcpServers: {
      'example-server': {
        type: 'sse',
        url: 'https://example.com/events'
      }
    }
  }, null, 2)
};

interface AddMcpState {
  mode: McpEditorMode;
  name: string;
  connectionType: McpConnectionType;
  commandLine: string;
  environmentText: string;
  url: string;
  jsonText: string;
  selectedAgents: readonly McpAgent[];
  isApplying: boolean;
  error: string | null;
  notice: string | null;
}

/** Immutable draft value shared by every control in the Add MCP dialog. */
class AddMcpPresentation {
  readonly state: AddMcpState;

  constructor(state: AddMcpState) {
    this.state = { ...state, selectedAgents: [...state.selectedAgents] };
  }

  static initial(): AddMcpPresentation {
    return new AddMcpPresentation({
      mode: 'wizard',
      name: '',
      connectionType: 'stdio',
      commandLine: '',
      environmentText: '',
      url: '',
      jsonText: '',
      selectedAgents: MCP_AGENT_ORDER,
      isApplying: false,
      error: null,
      notice: null
    });
  }

  replacing(changes: Partial<AddMcpState>): AddMcpPresentation {
    return new AddMcpPresentation({ ...this.state, ...changes });
  }

  draft(): McpConfigurationDraft {
    if (this.state.mode === 'json') {
      return { mode: 'json', jsonText: this.state.jsonText };
    }
    return {
      mode: 'wizard',
      name: this.state.name,
      connectionType: this.state.connectionType,
      commandLine: this.state.commandLine,
      environmentText: this.state.environmentText,
      url: this.state.url
    };
  }
}

interface AdditionValidation {
  preparation: McpConfigurationPreparation;
  blockingReason: string | null;
}

/** Owns catalog loading and every Add MCP dialog transition. */
class SkillsAndMcpsViewModel {
  private readonly scan: () => Promise<McpCatalogScan>;
  private readonly prepare: (draft: McpConfigurationDraft) => McpConfigurationPreparation;
  private readonly apply: (request: ApplyMcpConfigurationRequest) => Promise<McpCatalogScan>;
  private isLoading = false;
  private selectedMode: CatalogMode = 'mcps';
  private searchQuery = '';
  private installedMcps: InstalledMcp[] = [];
  private failures: McpCatalogScan['failures'] = [];
  private presentedAddition: AddMcpPresentation | null = null;

  constructor(options: {
    scan: () => Promise<McpCatalogScan>;
    prepare: (draft: McpConfigurationDraft) => McpConfigurationPreparation;
    apply: (request: ApplyMcpConfigurationRequest) => Promise<McpCatalogScan>;
  }) {
    this.scan = options.scan;
    this.prepare = options.prepare;
    this.apply = options.apply;
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

  get catalogFailures(): McpCatalogScan['failures'] {
    return [...this.failures];
  }

  get addition(): AddMcpPresentation | null {
    return this.presentedAddition;
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
      return [...this.installedMcps];
    }
    return this.installedMcps.filter((mcp) => mcp.title.toLocaleLowerCase().includes(normalizedQuery));
  }

  refresh(): Promise<void> {
    return this.loadInstalledMcps();
  }

  beginAddingMcp(): boolean {
    if (this.presentedAddition) {
      return false;
    }
    this.presentedAddition = AddMcpPresentation.initial();
    return true;
  }

  cancelMcpAddition(): void {
    if (!this.presentedAddition?.state.isApplying) {
      this.presentedAddition = null;
    }
  }

  updateMcpAddition(changes: Partial<AddMcpState>): void {
    const current = this.presentedAddition;
    if (!current || current.state.isApplying) {
      return;
    }
    let updated = current.replacing({ ...changes, error: null, notice: null });
    const connectionType = this.detectConnectionType(updated);
    if (connectionType) {
      const selectedAgents = updated.state.selectedAgents.filter((agent) =>
        this.isAgentSupported(agent, connectionType)
      );
      updated = updated.replacing({ selectedAgents });
    }
    this.presentedAddition = updated;
  }

  setMcpAgentSelected(agent: McpAgent, isSelected: boolean): void {
    const current = this.presentedAddition;
    if (!current || current.state.isApplying || !this.isAgentAvailable(agent)) {
      return;
    }
    const selectedAgents = isSelected
      ? MCP_AGENT_ORDER.filter((candidate) =>
        candidate === agent || current.state.selectedAgents.includes(candidate)
      )
      : current.state.selectedAgents.filter((candidate) => candidate !== agent);
    this.presentedAddition = current.replacing({ selectedAgents, error: null, notice: null });
  }

  isAgentAvailable(agent: McpAgent): boolean {
    const connectionType = this.presentedAddition
      ? this.detectConnectionType(this.presentedAddition)
      : null;
    return !connectionType || this.isAgentSupported(agent, connectionType);
  }

  additionValidation(): AdditionValidation {
    const addition = this.presentedAddition;
    const preparation = addition
      ? this.prepare(addition.draft())
      : { isValid: false, canonicalJson: null, configuration: null, error: 'Add MCP is not open.' };
    if (!addition || addition.state.selectedAgents.length === 0) {
      return { preparation, blockingReason: 'Select at least one supported agent.' };
    }
    if (!preparation.isValid) {
      return { preparation, blockingReason: preparation.error ?? 'Enter a valid MCP definition.' };
    }
    const incompatibleAgent = addition.state.selectedAgents.find((agent) =>
      !this.isAgentSupported(agent, preparation.configuration!.connectionType)
    );
    return {
      preparation,
      blockingReason: incompatibleAgent
        ? `${MCP_AGENT_LABELS[incompatibleAgent]} does not support this connection type.`
        : null
    };
  }

  validateMcpAddition(): void {
    const current = this.presentedAddition;
    if (!current || current.state.isApplying) {
      return;
    }
    const validation = this.additionValidation();
    this.presentedAddition = validation.preparation.isValid
      ? current.replacing({ error: null, notice: 'Configuration is valid.' })
      : current.replacing({ error: validation.preparation.error, notice: null });
  }

  formatMcpJson(): void {
    const current = this.presentedAddition;
    if (!current || current.state.isApplying) {
      return;
    }
    try {
      const parsedJson = JSON.parse(current.state.jsonText) as unknown;
      this.updateMcpAddition({ jsonText: JSON.stringify(parsedJson, null, 2) });
      this.validateMcpAddition();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.presentedAddition = current.replacing({ error: `Full JSON is malformed: ${detail}`, notice: null });
    }
  }

  useMcpExample(connectionType: McpConnectionType): void {
    this.updateMcpAddition({ jsonText: MCP_EXAMPLES[connectionType] });
  }

  async confirmMcpAddition(): Promise<boolean> {
    const current = this.presentedAddition;
    if (!current || current.state.isApplying) {
      return false;
    }
    const validation = this.additionValidation();
    if (validation.blockingReason || !validation.preparation.canonicalJson) {
      this.presentedAddition = current.replacing({
        error: validation.blockingReason ?? 'Enter a valid MCP definition.',
        notice: null
      });
      return false;
    }
    const selectedAgents = [...current.state.selectedAgents];
    this.presentedAddition = current.replacing({ isApplying: true, error: null, notice: null });
    try {
      const result = await this.apply({
        configurationJson: validation.preparation.canonicalJson,
        selectedAgents
      });
      this.installedMcps = [...result.servers];
      this.failures = [...result.failures];
      this.presentedAddition = null;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Unable to apply MCP configuration: ${message}`);
      this.presentedAddition = current.replacing({ isApplying: false, error: message, notice: null });
      return false;
    }
  }

  private detectConnectionType(addition: AddMcpPresentation): McpConnectionType | null {
    if (addition.state.mode === 'wizard') {
      return addition.state.connectionType;
    }
    return this.prepare(addition.draft()).configuration?.connectionType ?? null;
  }

  private isAgentSupported(agent: McpAgent, connectionType: McpConnectionType): boolean {
    return !(agent === 'codex' && connectionType === 'sse');
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

/** Owns the native dialog DOM while the ViewModel owns its data and transitions. */
class AddMcpDialog {
  private readonly viewModel: SkillsAndMcpsViewModel;
  private readonly onSuccess: () => void;
  private readonly onClosed: () => void;
  private readonly dialog = document.createElement('dialog');
  private readonly form = document.createElement('form');
  private readonly controls = document.createElement('fieldset');
  private readonly wizardButton = document.createElement('button');
  private readonly jsonButton = document.createElement('button');
  private readonly wizardSection = document.createElement('div');
  private readonly jsonSection = document.createElement('div');
  private readonly nameInput = document.createElement('input');
  private readonly connectionSelect = document.createElement('select');
  private readonly commandInput = document.createElement('input');
  private readonly commandLabel = document.createElement('span');
  private readonly environmentInput = document.createElement('input');
  private readonly environmentField = document.createElement('label');
  private readonly jsonInput = document.createElement('textarea');
  private readonly exampleSelect = document.createElement('select');
  private readonly agentInputs = new Map<McpAgent, HTMLInputElement>();
  private readonly agentTiles = new Map<McpAgent, HTMLElement>();
  private readonly closeButton = document.createElement('button');
  private readonly cancelButton = document.createElement('button');
  private readonly addButton = document.createElement('button');
  private readonly status = document.createElement('p');
  private didSucceed = false;

  constructor(options: {
    viewModel: SkillsAndMcpsViewModel;
    onSuccess: () => void;
    onClosed: () => void;
  }) {
    this.viewModel = options.viewModel;
    this.onSuccess = options.onSuccess;
    this.onClosed = options.onClosed;
    this.build();
    this.bindEvents();
  }

  open(): void {
    document.body.append(this.dialog);
    this.refresh();
    this.dialog.showModal();
    this.nameInput.focus();
  }

  private build(): void {
    this.dialog.className = 'add-dialog';
    this.form.method = 'dialog';
    this.form.className = 'add-dialog__form';
    this.controls.className = 'add-dialog__controls';
    this.controls.append(
      this.createModeControl(),
      this.createWizardSection(),
      this.createJsonSection(),
      this.createAgentSection(),
      this.status
    );
    const scrollArea = document.createElement('div');
    scrollArea.className = 'add-dialog__scroll';
    scrollArea.append(this.controls);
    this.form.append(this.createHeader(), scrollArea, this.createFooter());
    this.dialog.append(this.form);
  }

  private createHeader(): HTMLElement {
    const header = document.createElement('header');
    header.className = 'add-dialog__header';
    const title = document.createElement('h2');
    title.textContent = 'Add MCP';
    this.closeButton.type = 'button';
    this.closeButton.className = 'button button--quiet';
    this.closeButton.textContent = 'Close';
    header.append(title, this.closeButton);
    return header;
  }

  private createModeControl(): HTMLElement {
    const control = document.createElement('div');
    control.className = 'editor-mode';
    control.setAttribute('aria-label', 'MCP editor mode');
    this.configureModeButton(this.wizardButton, 'Config Wizard', 'wizard');
    this.configureModeButton(this.jsonButton, 'Full JSON', 'json');
    control.append(this.wizardButton, this.jsonButton);
    return control;
  }

  private configureModeButton(button: HTMLButtonElement, label: string, mode: McpEditorMode): void {
    button.type = 'button';
    button.className = 'editor-mode__button';
    button.textContent = label;
    button.addEventListener('click', () => {
      this.viewModel.updateMcpAddition({ mode });
      this.refresh();
    });
  }

  private createWizardSection(): HTMLElement {
    this.wizardSection.className = 'add-dialog__section field-grid';
    this.nameInput.type = 'text';
    this.nameInput.autocomplete = 'off';
    this.connectionSelect.append(
      this.createOption('stdio', 'Stdio'),
      this.createOption('streamable_http', 'Streamable HTTP'),
      this.createOption('sse', 'SSE')
    );
    this.commandInput.type = 'text';
    this.commandInput.autocomplete = 'off';
    this.environmentInput.type = 'text';
    this.environmentInput.autocomplete = 'off';
    this.environmentInput.placeholder = 'KEY=VALUE,KEY1=VALUE1';
    this.environmentField.className = 'form-field field-grid__wide';
    this.environmentField.append(this.createFieldLabel('Environment'), this.environmentInput);
    const commandField = document.createElement('label');
    commandField.className = 'form-field field-grid__wide';
    this.commandLabel.className = 'form-field__label';
    commandField.append(this.commandLabel, this.commandInput);
    this.wizardSection.append(
      this.createField('Name', this.nameInput),
      this.createField('Connection Type', this.connectionSelect),
      commandField,
      this.environmentField
    );
    return this.wizardSection;
  }

  private createJsonSection(): HTMLElement {
    this.jsonSection.className = 'add-dialog__section';
    const field = document.createElement('label');
    field.className = 'form-field';
    this.jsonInput.className = 'json-editor';
    this.jsonInput.spellcheck = false;
    field.append(this.createFieldLabel('Configuration JSON'), this.jsonInput);
    const actions = document.createElement('div');
    actions.className = 'json-actions';
    const formatButton = this.createActionButton('Format', () => {
      this.viewModel.formatMcpJson();
      this.refresh();
    });
    const validateButton = this.createActionButton('Validate', () => {
      this.viewModel.validateMcpAddition();
      this.refresh();
    });
    this.exampleSelect.setAttribute('aria-label', 'Example connection type');
    this.exampleSelect.append(
      this.createOption('stdio', 'Stdio example'),
      this.createOption('streamable_http', 'HTTP example'),
      this.createOption('sse', 'SSE example')
    );
    const exampleButton = this.createActionButton('Use Example', () => {
      this.viewModel.useMcpExample(this.exampleSelect.value as McpConnectionType);
      this.refresh();
    });
    actions.append(formatButton, validateButton, this.exampleSelect, exampleButton);
    this.jsonSection.append(field, actions);
    return this.jsonSection;
  }

  private createAgentSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'agent-section';
    const title = document.createElement('h3');
    title.textContent = 'Available to';
    const tiles = document.createElement('div');
    tiles.className = 'agent-picker';
    MCP_AGENT_ORDER.forEach((agent) => {
      const tile = document.createElement('label');
      tile.className = 'agent-tile';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        this.viewModel.setMcpAgentSelected(agent, input.checked);
        this.refresh();
      });
      const label = document.createElement('span');
      label.textContent = MCP_AGENT_LABELS[agent];
      tile.append(input, label);
      this.agentInputs.set(agent, input);
      this.agentTiles.set(agent, tile);
      tiles.append(tile);
    });
    section.append(title, tiles);
    return section;
  }

  private createFooter(): HTMLElement {
    const footer = document.createElement('footer');
    footer.className = 'add-dialog__footer';
    this.cancelButton.type = 'button';
    this.cancelButton.className = 'button button--secondary';
    this.cancelButton.textContent = 'Cancel';
    this.addButton.type = 'submit';
    this.addButton.className = 'button button--primary';
    this.addButton.textContent = 'Add MCP';
    footer.append(this.cancelButton, this.addButton);
    return footer;
  }

  private createField(labelText: string, control: HTMLElement): HTMLElement {
    const field = document.createElement('label');
    field.className = 'form-field';
    field.append(this.createFieldLabel(labelText), control);
    return field;
  }

  private createFieldLabel(labelText: string): HTMLElement {
    const label = document.createElement('span');
    label.className = 'form-field__label';
    label.textContent = labelText;
    return label;
  }

  private createOption(value: string, label: string): HTMLOptionElement {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  private createActionButton(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button--secondary';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  private bindEvents(): void {
    this.nameInput.addEventListener('input', () => this.handleFieldChange({ name: this.nameInput.value }));
    this.connectionSelect.addEventListener('change', () => this.handleFieldChange({
      connectionType: this.connectionSelect.value as McpConnectionType
    }));
    this.commandInput.addEventListener('input', () => {
      const changes = this.viewModel.addition?.state.connectionType === 'stdio'
        ? { commandLine: this.commandInput.value }
        : { url: this.commandInput.value };
      this.handleFieldChange(changes);
    });
    this.environmentInput.addEventListener('input', () => this.handleFieldChange({
      environmentText: this.environmentInput.value
    }));
    this.jsonInput.addEventListener('input', () => this.handleFieldChange({ jsonText: this.jsonInput.value }));
    this.closeButton.addEventListener('click', () => this.close());
    this.cancelButton.addEventListener('click', () => this.close());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.dialog.addEventListener('cancel', (event) => {
      if (this.viewModel.addition?.state.isApplying) {
        event.preventDefault();
      }
    });
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog && !this.viewModel.addition?.state.isApplying) {
        this.close();
      }
    });
    this.dialog.addEventListener('close', () => {
      if (!this.didSucceed) {
        this.viewModel.cancelMcpAddition();
      }
      this.dialog.remove();
      this.onClosed();
    });
  }

  private handleFieldChange(changes: Partial<AddMcpState>): void {
    this.viewModel.updateMcpAddition(changes);
    this.refresh();
  }

  private refresh(): void {
    const addition = this.viewModel.addition;
    if (!addition) {
      return;
    }
    const state = addition.state;
    this.syncValue(this.nameInput, state.name);
    this.connectionSelect.value = state.connectionType;
    this.syncValue(this.commandInput, state.connectionType === 'stdio' ? state.commandLine : state.url);
    this.syncValue(this.environmentInput, state.environmentText);
    this.syncValue(this.jsonInput, state.jsonText);
    this.wizardSection.hidden = state.mode !== 'wizard';
    this.jsonSection.hidden = state.mode !== 'json';
    this.setModeButtonState(this.wizardButton, state.mode === 'wizard');
    this.setModeButtonState(this.jsonButton, state.mode === 'json');
    const isRemote = state.connectionType !== 'stdio';
    this.commandLabel.textContent = isRemote ? 'URL' : 'Command';
    this.environmentField.hidden = isRemote;
    MCP_AGENT_ORDER.forEach((agent) => this.refreshAgent(agent, state));
    this.controls.disabled = state.isApplying;
    this.closeButton.disabled = state.isApplying;
    this.cancelButton.disabled = state.isApplying;
    const validation = this.viewModel.additionValidation();
    this.addButton.disabled = state.isApplying || validation.blockingReason !== null;
    this.addButton.title = validation.blockingReason ?? '';
    this.addButton.textContent = state.isApplying ? 'Adding...' : 'Add MCP';
    this.refreshStatus(state);
  }

  private refreshAgent(agent: McpAgent, state: AddMcpState): void {
    const input = this.agentInputs.get(agent);
    const tile = this.agentTiles.get(agent);
    if (!input || !tile) {
      return;
    }
    const isAvailable = this.viewModel.isAgentAvailable(agent);
    input.checked = state.selectedAgents.includes(agent);
    input.disabled = state.isApplying || !isAvailable;
    tile.className = `agent-tile${input.checked ? ' agent-tile--selected' : ''}${!isAvailable ? ' agent-tile--disabled' : ''}`;
    tile.title = isAvailable ? '' : `${MCP_AGENT_LABELS[agent]} does not support SSE.`;
  }

  private refreshStatus(state: AddMcpState): void {
    const message = state.error ?? state.notice;
    this.status.hidden = !message;
    this.status.textContent = message ?? '';
    this.status.className = state.error
      ? 'form-status form-status--error'
      : 'form-status form-status--success';
  }

  private setModeButtonState(button: HTMLButtonElement, isSelected: boolean): void {
    button.className = `editor-mode__button${isSelected ? ' editor-mode__button--selected' : ''}`;
    button.setAttribute('aria-pressed', String(isSelected));
  }

  private syncValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    if (control.value !== value) {
      control.value = value;
    }
  }

  private async submit(): Promise<void> {
    const confirmation = this.viewModel.confirmMcpAddition();
    this.refresh();
    const didSucceed = await confirmation;
    if (didSucceed) {
      this.didSucceed = true;
      this.dialog.close();
      this.onSuccess();
      return;
    }
    this.refresh();
  }

  private close(): void {
    if (!this.viewModel.addition?.state.isApplying) {
      this.dialog.close();
    }
  }
}

/** Renders the local MCP catalog without exposing Electron APIs to the DOM. */
class RendererApp {
  private readonly rootElement: HTMLElement;
  private readonly viewModel: SkillsAndMcpsViewModel;
  private detailDialog: HTMLDialogElement | null = null;
  private addDialog: AddMcpDialog | null = null;

  constructor() {
    const rootElement = document.getElementById('app');
    if (!(rootElement instanceof HTMLElement)) {
      throw new Error('The application root is missing.');
    }
    this.rootElement = rootElement;
    this.viewModel = new SkillsAndMcpsViewModel({
      scan: () => window.tokiie.getInstalledMcps(),
      prepare: (draft) => window.tokiie.prepareMcpConfiguration(draft),
      apply: (request) => window.tokiie.applyMcpConfiguration(request)
    });
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
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search MCPs';
    input.value = this.viewModel.query;
    input.addEventListener('input', () => this.handleSearchInput(input));
    searchLabel.append(input);
    const actions = document.createElement('div');
    actions.className = 'catalog-toolbar__actions';
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'button button--secondary';
    refreshButton.textContent = this.viewModel.loading ? 'Scanning...' : 'Refresh';
    refreshButton.disabled = this.viewModel.loading;
    refreshButton.addEventListener('click', () => {
      void this.viewModel.refresh().then(() => this.render());
    });
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'button button--primary';
    addButton.textContent = '+ Add MCP';
    addButton.addEventListener('click', () => this.openAddDialog());
    actions.append(refreshButton, addButton);
    toolbar.append(searchLabel, actions);
    return toolbar;
  }

  private handleSearchInput(input: HTMLInputElement): void {
    const selectionStart = input.selectionStart ?? input.value.length;
    this.viewModel.setSearchQuery(input.value);
    this.render();
    const nextInput = this.rootElement.querySelector<HTMLInputElement>('input[type="search"]');
    nextInput?.focus();
    nextInput?.setSelectionRange(selectionStart, selectionStart);
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
      content.append(this.createEmptyState());
    }
    for (const failure of this.viewModel.catalogFailures) {
      const failureRow = document.createElement('p');
      failureRow.className = 'catalog-failure';
      failureRow.textContent = `${MCP_AGENT_LABELS[failure.agent]}: ${failure.message}`;
      content.append(failureRow);
    }
    return content;
  }

  private createEmptyState(): HTMLElement {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    const title = document.createElement('h2');
    title.textContent = this.viewModel.query.trim().length > 0 ? 'No matches' : 'No MCPs yet';
    const message = document.createElement('p');
    message.textContent = this.viewModel.query.trim().length > 0
      ? 'Try a different name.'
      : 'Configured MCP servers will appear here.';
    emptyState.append(title, message);
    return emptyState;
  }

  private createMcpCard(mcp: InstalledMcp): HTMLElement {
    const card = document.createElement('article');
    card.className = 'mcp-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.addEventListener('click', () => this.openDetails(mcp));
    card.addEventListener('keydown', (event) => this.handleCardKey(event, mcp));
    const heading = document.createElement('h2');
    heading.className = 'mcp-card__title';
    heading.textContent = mcp.title;
    const transport = document.createElement('span');
    transport.className = 'mcp-card__transport';
    transport.textContent = MCP_CONNECTION_LABELS[mcp.connectionType];
    const badges = document.createElement('div');
    badges.className = 'agent-badges';
    mcp.badges.forEach((badge) => badges.append(this.createAgentBadge(badge)));
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

  private createAgentBadge(badge: InstalledMcp['badges'][number]): HTMLElement {
    const badgeElement = document.createElement('span');
    badgeElement.className = `agent-badge agent-badge--${badge.state}`;
    badgeElement.textContent = MCP_AGENT_LABELS[badge.agent];
    badgeElement.title = badge.state === 'checked'
      ? 'Configured'
      : badge.state === 'disabled' ? 'Unsupported transport' : 'Not configured';
    return badgeElement;
  }

  private handleCardKey(event: KeyboardEvent, mcp: InstalledMcp): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.openDetails(mcp);
    }
  }

  private openAddDialog(): void {
    if (this.addDialog || !this.viewModel.beginAddingMcp()) {
      return;
    }
    this.addDialog = new AddMcpDialog({
      viewModel: this.viewModel,
      onSuccess: () => this.render(),
      onClosed: () => {
        this.addDialog = null;
      }
    });
    this.addDialog.open();
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
    description.textContent = `${MCP_CONNECTION_LABELS[mcp.connectionType]} | ${mcp.agents.map((agent) => MCP_AGENT_LABELS[agent]).join(', ')}`;
    const definition = document.createElement('pre');
    definition.className = 'detail-dialog__definition';
    definition.textContent = mcp.definition;
    dialog.append(header, description, definition);
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
