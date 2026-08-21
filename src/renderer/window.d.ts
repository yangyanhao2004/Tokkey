import type { TokiieApi } from '../shared/types';

declare global {
  interface Window {
    tokiie: TokiieApi;
  }
}

export {};
