import type { TokkeyApi } from '../shared/types';

declare global {
  interface Window {
    tokkey: TokkeyApi;
  }
}

export {};
