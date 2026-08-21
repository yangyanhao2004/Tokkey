/** A validated, canonical GitHub repository reference. */
export default class GitHubRepositoryCoordinate {
  readonly owner: string;
  readonly name: string;
  readonly source: string;
  readonly cloneUrl: string;

  /** Normalizes a clipboard value and rejects anything outside owner/name. */
  constructor(userInput: string) {
    const segments = GitHubRepositoryCoordinate.parseSegments(userInput);
    this.owner = segments[0];
    this.name = segments[1];
    this.source = `${this.owner}/${this.name}`;
    this.cloneUrl = `https://github.com/${this.source}.git`;
  }

  /** Returns null instead of throwing when validating a form field. */
  static tryParse(userInput: string): GitHubRepositoryCoordinate | null {
    try {
      return new GitHubRepositoryCoordinate(userInput);
    } catch {
      return null;
    }
  }

  /** Parses a value using the conventional value-object factory name. */
  static parse(userInput: string): GitHubRepositoryCoordinate {
    return new GitHubRepositoryCoordinate(userInput);
  }

  /** Indicates whether a form value can be normalized without throwing. */
  static isValid(userInput: string): boolean {
    return this.tryParse(userInput) !== null;
  }

  /** Alias for code that calls the canonical source a repository identifier. */
  get repository(): string {
    return this.source;
  }

  /** Creates a coordinate from a plain source value without accepting mutation. */
  static fromSource(source: string): GitHubRepositoryCoordinate {
    return new GitHubRepositoryCoordinate(source);
  }

  /** Parses HTTPS, SSH, host-only, and owner/name clipboard forms. */
  private static parseSegments(userInput: string): [string, string] {
    if (typeof userInput !== 'string' || userInput.trim().length === 0) {
      throw new TypeError('GitHub repository must be a non-empty string');
    }

    const trimmedInput = userInput.trim();
    if (/(?:^|[/:])\.\.(?:[/:]|$)/.test(trimmedInput)) {
      throw new TypeError('GitHub repository contains a traversal segment');
    }
    let repositoryPath = trimmedInput;
    if (trimmedInput.startsWith('git@github.com:')) {
      repositoryPath = trimmedInput.slice('git@github.com:'.length);
    } else if (/^https?:\/\//i.test(trimmedInput)) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(trimmedInput);
      } catch {
        throw new TypeError('Invalid GitHub repository URL');
      }
      if (!/^(?:www\.)?github\.com$/i.test(parsedUrl.hostname)) {
        throw new TypeError('Repository URL must point to github.com');
      }
      repositoryPath = parsedUrl.pathname;
    } else if (/^(?:www\.)?github\.com\//i.test(trimmedInput)) {
      repositoryPath = trimmedInput.replace(/^(?:www\.)?github\.com\//i, '');
    }

    const withoutQuery = repositoryPath.split(/[?#]/, 1)[0] ?? '';
    const normalizedPath = withoutQuery.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    const rawSegments = normalizedPath.split('/');
    if (rawSegments.some((segment) => segment.length === 0)) {
      throw new TypeError('GitHub repository contains an empty path segment');
    }
    const segments = rawSegments;
    if (segments.length !== 2) {
      throw new TypeError('GitHub repository must use owner/name format');
    }

    const owner = segments[0];
    const name = segments[1];
    if (!owner || !name || !this.isSafeSegment(owner) || !this.isSafeSegment(name)) {
      throw new TypeError('GitHub repository contains an invalid owner or name');
    }
    return [owner, name];
  }

  /** Restricts cache path segments to safe GitHub-like names. */
  private static isSafeSegment(segment: string): boolean {
    return segment !== '.' && segment !== '..' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);
  }
}

export { GitHubRepositoryCoordinate };
