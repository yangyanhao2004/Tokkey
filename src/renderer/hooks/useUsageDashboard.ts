import { useCallback, useEffect, useRef, useState } from 'react';
import { UsageDashboardModel, type UsageDashboardState } from './UsageDashboardModel';

/** What the Dashboard draws, and what it can do to the listing under it. */
export interface UsageDashboard extends UsageDashboardState {
  loadMore: () => void;
}

/** Keeps live reads scoped to the mounted dashboard and discards late IPC replies. */
export function useUsageDashboard(): UsageDashboard {
  const model = useRef<UsageDashboardModel | null>(null);
  const [state, setState] = useState(UsageDashboardModel.initialState);

  useEffect(() => {
    const mountedModel = new UsageDashboardModel(window.tokkey, setState);
    model.current = mountedModel;
    setState(UsageDashboardModel.initialState());
    mountedModel.start();
    return () => {
      mountedModel.stop();
      model.current = null;
    };
  }, []);

  const loadMore = useCallback(() => {
    void model.current?.loadMore();
  }, []);

  return {
    ...state,
    loadMore
  };
}
