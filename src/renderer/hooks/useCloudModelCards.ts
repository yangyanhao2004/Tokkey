import { useCallback, useEffect, useRef, useState } from 'react';
import type { CloudModelCard } from '../../shared/types';

export interface CloudModelCards {
  /** The catalog the main process shipped, or `null` before it arrives. */
  cards: CloudModelCard[] | null;
  /** The card whose connect is still running, so its button can report it. */
  connectingCardId: string | null;
  /** The connected card, which is also the one Router routes complex tasks to. */
  connectedCardId: string | null;
  /** Why the catalog could not be read, if it could not. */
  listError: string | null;
  /** Why the last connect failed, cleared by the next one that succeeds. */
  connectError: string | null;
  connect: (cardId: string) => void;
}

/**
 * The cloud offerings served by `CloudModelCatalog`, plus the connect the
 * "Select" button runs.
 *
 * The catalog is fixed for the life of the app, so it is read once on mount and
 * never refreshed; `null` means no answer has arrived yet.
 *
 * A card only counts as connected once the main process says so: the connector
 * creates the gateway route and the profile, or reports that both already
 * exist, and either way the card is safe to select. A failed connect leaves the
 * previous selection alone rather than pointing Router at a route that is not
 * there.
 */
export function useCloudModelCards(): CloudModelCards {
  const [cards, setCards] = useState<CloudModelCard[] | null>(null);
  const [connectingCardId, setConnectingCardId] = useState<string | null>(null);
  const [connectedCardId, setConnectedCardId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  // Guards against a call that resolves after unmount setting state.
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const list = async () => {
      try {
        const listed = await window.tokiie.listCloudModelCards();
        if (!isMountedRef.current) return;
        setCards(listed);
        setListError(null);
      } catch (cause) {
        if (!isMountedRef.current) return;
        setCards([]);
        setListError(describe(cause));
      }
    };

    // What survives a restart: the gateway loses its routes, the database keeps
    // the profiles, so the restore rebuilds the routes and reports which cards
    // an earlier run had connected. It is kept apart from the listing because a
    // gateway that never came up must not hide the catalog.
    const restore = async () => {
      try {
        const restored = await window.tokiie.restoreCloudModels();
        if (!isMountedRef.current) return;
        // Router routes to one cloud model, and which one is not itself
        // persisted, so the first restored card stands in for the selection.
        // A card selected while the restore was still running keeps its place:
        // the user's own choice is never overwritten by what it found.
        setConnectedCardId((current) => current ?? restored[0]?.card.id ?? null);
      } catch (cause) {
        if (!isMountedRef.current) return;
        setConnectError(describe(cause));
      }
    };

    void list();
    void restore();
  }, []);

  const connect = useCallback(
    (cardId: string) => {
      // Connecting the card already selected would only re-confirm it, and a
      // second click while one connect is in flight would race it.
      if (cardId === connectedCardId || connectingCardId !== null) return;

      const run = async () => {
        setConnectingCardId(cardId);
        try {
          const connection = await window.tokiie.connectCloudModel(cardId);
          if (!isMountedRef.current) return;
          setConnectedCardId(connection.card.id);
          setConnectError(null);
        } catch (cause) {
          if (!isMountedRef.current) return;
          setConnectError(describe(cause));
        } finally {
          if (isMountedRef.current) {
            setConnectingCardId(null);
          }
        }
      };

      void run();
    },
    [connectedCardId, connectingCardId]
  );

  return { cards, connectingCardId, connectedCardId, listError, connectError, connect };
}

/** The message an IPC rejection carries, whatever shape it arrived in. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
