import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_ROUTE, NavigationHistory, type RouteId } from '../routing';

interface NavigationValue {
  /** The route being shown. */
  route: RouteId;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Visits a route, dropping anything that was ahead in the history. */
  navigate: (route: RouteId) => void;
  goBack: () => void;
  goForward: () => void;
}

/** Null until a provider supplies it, so the hook below fails loudly. */
const NavigationContext = createContext<NavigationValue | null>(null);

/**
 * One history for the whole window.
 *
 * The header's Back and Forward buttons sit inside every page, while the moves
 * they undo are made by the sidebar and by buttons deep inside page content, so
 * no page can own this. Holding it here is also what lets a sub-page like "Add
 * model" be navigated to rather than toggled by its parent's local state.
 */
export function NavigationProvider({ children }: { children: ReactNode }) {
  const [history, setHistory] = useState(() => NavigationHistory.of(DEFAULT_ROUTE));

  const navigate = useCallback((route: RouteId) => {
    setHistory((current) => current.push(route));
  }, []);

  const goBack = useCallback(() => {
    setHistory((current) => current.back());
  }, []);

  const goForward = useCallback(() => {
    setHistory((current) => current.forward());
  }, []);

  const value = useMemo<NavigationValue>(
    () => ({
      route: history.current,
      canGoBack: history.canGoBack,
      canGoForward: history.canGoForward,
      navigate,
      goBack,
      goForward
    }),
    [history, navigate, goBack, goForward]
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/** The window's history. Throws outside a provider rather than failing later. */
export function useNavigation(): NavigationValue {
  const value = useContext(NavigationContext);
  if (!value) {
    throw new Error('Navigation is only available inside a NavigationProvider.');
  }
  return value;
}
