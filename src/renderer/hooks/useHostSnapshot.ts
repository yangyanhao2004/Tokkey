import { useEffect, useState } from 'react';
import type { HostSnapshot } from '../../shared/types';

/** Matches Activity Monitor's refresh cadence without churning the main process. */
const HOST_POLL_INTERVAL_MS = 5000;

/**
 * Live memory and disk readings for the "This Mac" card.
 *
 * Polls only while the component is mounted, so nothing runs off-screen. A
 * failed reading keeps the previous one on screen rather than blanking the
 * gauges; `null` means no reading has arrived yet.
 */
export function useHostSnapshot(): HostSnapshot | null {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);

  useEffect(() => {
    // Guards against a reading that resolves after unmount setting state.
    let isMounted = true;

    const poll = async () => {
      try {
        const reading = await window.tokiie.getHostSnapshot();
        if (isMounted) {
          setSnapshot(reading);
        }
      } catch (error) {
        console.error('Host snapshot failed:', error);
      }
    };

    void poll();
    const timer = setInterval(poll, HOST_POLL_INTERVAL_MS);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, []);

  return snapshot;
}
