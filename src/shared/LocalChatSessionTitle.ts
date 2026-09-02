export const DEFAULT_LOCAL_CHAT_SESSION_TITLE = 'New Private Chat';

/** Creates the compact first-message title shared by persisted and live tabs. */
export function createLocalChatSessionTitle(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 80
    ? `${compact.slice(0, 77)}...`
    : compact || DEFAULT_LOCAL_CHAT_SESSION_TITLE;
}
