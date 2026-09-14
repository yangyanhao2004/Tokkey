import type { TokkeyApi, UsageCostTotals, UsageQueryRecord, UsageQueryWindow } from '../../shared/types';

export interface UsageDashboardState {
  readonly queries: readonly UsageQueryRecord[];
  readonly totals: UsageCostTotals | null;
  readonly isLoading: boolean;
  readonly isLoadingMore: boolean;
  readonly hasMore: boolean;
  readonly error: string | null;
}

type UsageReader = Pick<TokkeyApi,
  'readUsageQueryWindow' | 'readUsageCostTotals' | 'readUsageDataVersion'>;

const REFRESH_INTERVAL_MS = 1_000;
const READ_FAILED_MESSAGE = 'Usage history could not be read.';

/** Owns live reads so polling, pagination, and teardown share one request queue. */
export class UsageDashboardModel {
  private state: UsageDashboardState = UsageDashboardModel.initialState();
  private nextCursor: string | null = null;
  private dataVersion: number | null | undefined;
  private isReading = false;
  private isStopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly reader: UsageReader,
    private readonly onChange: (state: UsageDashboardState) => void
  ) {}

  static initialState(): UsageDashboardState {
    return {
      queries: [], totals: null, isLoading: true, isLoadingMore: false, hasMore: false, error: null
    };
  }

  /** The hook creates a fresh model on every mount, including Strict Mode remounts. */
  start(): void {
    void this.refresh();
  }

  stop(): void {
    this.isStopped = true;
    this.clearTimer();
  }

  async loadMore(): Promise<void> {
    if (this.isStopped || this.isReading || this.nextCursor === null) return;
    this.isReading = true;
    this.clearTimer();
    this.publish({ isLoadingMore: true });
    try {
      const batch = await this.reader.readUsageQueryWindow(this.nextCursor);
      if (this.isStopped) return;
      this.nextCursor = batch.nextCursor;
      this.publish({
        queries: [...this.state.queries, ...batch.queries],
        hasMore: batch.nextCursor !== null,
        error: null
      });
    } catch (error) {
      this.reportError(error);
    } finally {
      this.isReading = false;
      this.publish({ isLoadingMore: false });
      this.scheduleRefresh();
    }
  }

  /** Poll only the version while idle; expensive reads happen after a commit. */
  private async refresh(): Promise<void> {
    if (this.isStopped || this.isReading) return;
    this.isReading = true;
    try {
      const version = await this.reader.readUsageDataVersion();
      if (this.isStopped) return;
      if (version !== this.dataVersion || this.state.error !== null) {
        // Drain both reads even if one fails, so a retry cannot overlap a slow sibling.
        const [batchResult, totalsResult] = await Promise.allSettled([
          this.readVisibleQueries(), this.reader.readUsageCostTotals()
        ]);
        if (batchResult.status === 'rejected') throw batchResult.reason;
        if (totalsResult.status === 'rejected') throw totalsResult.reason;
        const batch = batchResult.value;
        const totals = totalsResult.value;
        if (this.isStopped) return;
        // Keep the version from BEFORE reading: commits during a read must trigger
        // another refresh, rather than being silently treated as already displayed.
        this.dataVersion = version;
        this.nextCursor = batch.nextCursor;
        this.publish({ queries: batch.queries, totals, hasMore: batch.nextCursor !== null, error: null });
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      this.isReading = false;
      this.publish({ isLoading: false });
      this.scheduleRefresh();
    }
  }

  /** Refresh through the oldest displayed row so new queries never evict loaded history. */
  private async readVisibleQueries(): Promise<UsageQueryWindow> {
    const oldest = this.state.queries.at(-1);
    let batch = await this.reader.readUsageQueryWindow(null);
    let queries = batch.queries;
    while (!this.isStopped && oldest && batch.nextCursor !== null &&
      UsageDashboardModel.isNewer(queries.at(-1), oldest)) {
      batch = await this.reader.readUsageQueryWindow(batch.nextCursor);
      queries = [...queries, ...batch.queries];
    }
    return { queries, nextCursor: batch.nextCursor };
  }

  /** Match SQLite's timestamp/session/turn ordering, including a deleted boundary row. */
  private static isNewer(query: UsageQueryRecord | undefined, boundary: UsageQueryRecord): boolean {
    if (!query) return false;
    if (query.startedAtEpochMs !== boundary.startedAtEpochMs) {
      return query.startedAtEpochMs > boundary.startedAtEpochMs;
    }
    if (query.sessionId !== boundary.sessionId) return query.sessionId > boundary.sessionId;
    return query.turnId > boundary.turnId;
  }

  private reportError(error: unknown): void {
    if (this.isStopped) return;
    console.error('Usage dashboard read failed:', error);
    // Keep the last good figures on screen and retry even if the version is unchanged.
    this.publish({ error: READ_FAILED_MESSAGE });
  }

  private publish(update: Partial<UsageDashboardState>): void {
    if (this.isStopped) return;
    const isUnchanged = Object.entries(update).every(
      ([key, value]) => this.state[key as keyof UsageDashboardState] === value
    );
    if (isUnchanged) return;
    this.state = { ...this.state, ...update };
    this.onChange(this.state);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Schedule after completion so slow reads cannot pile up or race with Load more. */
  private scheduleRefresh(): void {
    this.clearTimer();
    if (!this.isStopped) this.timer = setTimeout(() => void this.refresh(), REFRESH_INTERVAL_MS);
  }
}
