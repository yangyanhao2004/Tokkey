import type {
  AgentOperationResult,
  ShellAgent,
  ShellRunResult,
  ShellRunner
} from './AgentTypes';
import StreamingShellRunner from './StreamingShellRunner';
import AgentInstaller from './AgentInstaller';

export interface ShellAgentInstallerOptions {
  shellRunner?: ShellRunner;
  timeoutMs?: number;
}

/** Owns the official-first install and command-v based uninstall scripts. */
export class ShellAgentInstaller extends AgentInstaller {
  static readonly PRODUCTION_TIMEOUT_MS = 20 * 60 * 1000;

  private readonly shellRunner: ShellRunner;
  private readonly timeoutMs: number;

  constructor(shellRunner?: ShellRunner, timeoutMs?: number);
  constructor(options?: ShellAgentInstallerOptions);
  constructor(shellRunnerOrOptions: ShellRunner | ShellAgentInstallerOptions = {}, timeoutMs = ShellAgentInstaller.PRODUCTION_TIMEOUT_MS) {
    super();
    if ('run' in shellRunnerOrOptions) {
      this.shellRunner = shellRunnerOrOptions;
      this.timeoutMs = timeoutMs;
      return;
    }
    this.shellRunner = shellRunnerOrOptions.shellRunner ?? new StreamingShellRunner();
    this.timeoutMs = shellRunnerOrOptions.timeoutMs ?? timeoutMs;
  }

  /** Builds the exact non-interactive installer selected for one supported agent. */
  static installCommand(agent: ShellAgent): string {
    ShellAgentInstaller.assertAgent(agent);
    if (agent === 'codex') return ShellAgentInstaller.codexInstallCommand();
    return ShellAgentInstaller.claudeInstallCommand();
  }

  /** Instance form is convenient for callers that hold an installer object. */
  installCommand(agent: ShellAgent): string {
    return ShellAgentInstaller.installCommand(agent);
  }

  /** Runs one official installer and turns its process result into a domain result. */
  async install(agent: ShellAgent, onLine?: (line: string) => void): Promise<AgentOperationResult> {
    const result = await this.shellRunner.run(ShellAgentInstaller.installCommand(agent), {
      shell: '/bin/bash',
      login: true,
      timeoutMs: this.timeoutMs,
      onLine
    });
    return this.toOperationResult(agent, result);
  }

  /** Removes only the executable found by command -v and leaves agent data untouched. */
  async uninstall(agent: ShellAgent, onLine?: (line: string) => void): Promise<AgentOperationResult> {
    const result = await this.shellRunner.run(ShellAgentInstaller.uninstallCommand(agent), {
      shell: '/bin/bash',
      login: true,
      timeoutMs: this.timeoutMs,
      onLine
    });
    return this.toOperationResult(agent, result);
  }

  /** Builds a safe command-v based removal without touching ~/.codex or ~/.claude. */
  static uninstallCommand(agent: ShellAgent): string {
    ShellAgentInstaller.assertAgent(agent);
    return [
      'set -eo pipefail',
      `AGENT_EXECUTABLE="$(command -v ${agent} || true)"`,
      'if [ -n "$AGENT_EXECUTABLE" ]; then',
      '  rm -f -- "$AGENT_EXECUTABLE"',
      'fi',
      `echo "${agent} uninstall complete"`
    ].join('\n');
  }

  private static codexInstallCommand(): string {
    return [
      'set -eo pipefail',
      'if curl -fsS --max-time 8 -o /dev/null https://chatgpt.com/codex/install.sh; then',
      '  curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
      'else',
      '  CODEX_INSTALLER_TMP="$(mktemp)"',
      '  trap \'rm -f "$CODEX_INSTALLER_TMP"\' EXIT',
      '  curl -fsSL --retry 3 --retry-all-errors --retry-max-time 120 \\',
      '    --connect-timeout 10 --max-time 30 \\',
      '    -o "$CODEX_INSTALLER_TMP" \\',
      '    https://v4.gh-proxy.com/https://raw.githubusercontent.com/openai/codex/main/scripts/install/install.sh',
      "  sed 's#https://github.com#https://v4.gh-proxy.com/https://github.com#g' \"$CODEX_INSTALLER_TMP\" \\",
      '    | CODEX_NON_INTERACTIVE=1 sh',
      '  rm -f "$CODEX_INSTALLER_TMP"',
      '  trap - EXIT',
      'fi',
      'echo "Codex installation complete"'
    ].join('\n');
  }

  private static claudeInstallCommand(): string {
    return [
      'set -eo pipefail',
      'if ! curl -fsS --max-time 8 -o /dev/null https://claude.ai/install.sh; then',
      '  echo "Claude installer unavailable; Claude may not be available in this country." >&2',
      '  exit 1',
      'fi',
      'curl -fsSL https://claude.ai/install.sh | bash',
      'echo "Claude installation complete"'
    ].join('\n');
  }

  private toOperationResult(agent: ShellAgent, result: ShellRunResult): AgentOperationResult {
    const succeeded = result.exitCode === 0 && !result.timedOut;
    return {
      ...result,
      kind: succeeded ? 'success' : 'failure',
      agent,
      error: succeeded ? null : this.failureMessage(agent, result)
    };
  }

  private failureMessage(agent: ShellAgent, result: ShellRunResult): string {
    if (result.timedOut) return `${agent} installation timed out.`;
    return result.diagnosticTail?.join('\n') || `${agent} installer exited with code ${result.exitCode ?? 'unknown'}.`;
  }

  /** Keeps JavaScript callers from selecting an unintended shell script. */
  private static assertAgent(agent: ShellAgent): void {
    if (agent !== 'codex' && agent !== 'claude') throw new TypeError(`Unsupported agent: ${String(agent)}`);
  }
}

export default ShellAgentInstaller;
