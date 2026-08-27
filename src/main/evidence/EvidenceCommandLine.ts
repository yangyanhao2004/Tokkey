export interface EvidenceCommandLineOptions {
  width: number;
  height: number;
  outputDirectory: string;
}

/** Parses the narrow command-line contract used by the renderer evidence mode. */
export class EvidenceCommandLine {
  /**
   * @param arguments process arguments after Electron's own flags
   * @throws when evidence dimensions or output are invalid
   */
  static parse(argumentsList: readonly string[]): EvidenceCommandLineOptions | null {
    if (!argumentsList.includes('--evidence')) {
      return null;
    }

    const width = EvidenceCommandLine.readPositiveInteger(argumentsList, '--width');
    const height = EvidenceCommandLine.readPositiveInteger(argumentsList, '--height');
    const outputDirectory = EvidenceCommandLine.readValue(argumentsList, '--output') ?? '.artifacts/renderer';
    return { width, height, outputDirectory };
  }

  /** Reads one positive integer option required by a deterministic evidence run. */
  private static readPositiveInteger(argumentsList: readonly string[], option: string): number {
    const value = EvidenceCommandLine.readValue(argumentsList, option);
    if (value === null) {
      throw new Error(`${option} is required for evidence capture.`);
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${option} must be a positive integer, received ${value}.`);
    }
    return parsed;
  }

  /** Reads a value following an option and rejects an accidentally missing value. */
  private static readValue(argumentsList: readonly string[], option: string): string | null {
    const index = argumentsList.indexOf(option);
    if (index < 0) return null;
    const value = argumentsList[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${option} requires a value.`);
    }
    return value;
  }
}

export default EvidenceCommandLine;
