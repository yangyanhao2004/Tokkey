import type { LocalModelRuntimePhase, PetRuntimePhase } from '../../shared/types';

export type PetCompanionSignal =
  | { source: 'gateway'; phase: 'stopped' | 'starting' | 'running' | 'error' }
  | { source: 'router'; phase: 'stopped' | 'starting' | 'running' | 'error' }
  // The local model's own lifecycle, so a phase added to the runtime reaches
  // the Pet rather than being silently dropped here.
  | { source: 'model'; phase: LocalModelRuntimePhase }
  | {
      source: 'chat';
      phase: 'sending' | 'completed' | 'cancelled' | 'error';
      turnId: string;
    };

export interface PetCompanionFeedback {
  phase: Extract<
    PetRuntimePhase,
    'walking' | 'working' | 'thinking' | 'celebrating' | 'serviceError'
  >;
  message: string | null;
}

export interface PetCompanionSnapshot {
  gateway: 'stopped' | 'starting' | 'running' | 'error';
  router: 'stopped' | 'starting' | 'running' | 'error';
  model: LocalModelRuntimePhase;
  activeChatTurnCount: number;
}

/** Resolves concurrent Tokkey activity to the one status the Pet should show. */
export function resolvePetCompanionFeedback(
  snapshot: PetCompanionSnapshot
): PetCompanionFeedback {
  if (snapshot.activeChatTurnCount > 0) {
    return { phase: 'thinking', message: 'Thinking...' };
  }
  if (snapshot.router === 'error') {
    return { phase: 'serviceError', message: 'Router needs attention.' };
  }
  if (snapshot.gateway === 'error') {
    return { phase: 'serviceError', message: 'Gateway needs attention.' };
  }
  if (snapshot.model === 'starting') {
    return { phase: 'working', message: 'Starting local model...' };
  }
  if (snapshot.model === 'stopping') {
    return { phase: 'working', message: 'Stopping local model...' };
  }
  if (snapshot.router === 'starting') {
    return { phase: 'working', message: 'Starting Router...' };
  }
  if (snapshot.gateway === 'starting') {
    return { phase: 'working', message: 'Starting Gateway...' };
  }
  return { phase: 'walking', message: null };
}
