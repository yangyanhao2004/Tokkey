import type { TokieApi } from '../shared/types';

declare global {
  interface Window {
    tokie: TokieApi;
  }
}

export {};
