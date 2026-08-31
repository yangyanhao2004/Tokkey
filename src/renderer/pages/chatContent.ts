import type { ReactNode } from 'react';

export type ChatMessageRole = 'user' | 'assistant';
export type ChatMessageStatus = 'complete' | 'streaming' | 'error';
export type ChatRequestState = 'idle' | 'sending' | 'error';
export type ChatModelState = 'available' | 'unavailable' | 'loading' | 'error';

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  createdAt: number;
  durationLabel: string | null;
  status: ChatMessageStatus;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  preview: string | null;
}

export interface TokenUsageFixture {
  usedContextTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindowTokens: number;
}

export const TOKEN_USAGE_FIXTURE: TokenUsageFixture = {
  usedContextTokens: 12,
  inputTokens: 100,
  outputTokens: 10,
  totalTokens: 110,
  contextWindowTokens: 1048576
};

export interface ChatModelOption {
  id: string;
  label: string;
  source: 'local';
  isAvailable: boolean;
}

export interface ChatHistoryGroup {
  label: 'Today' | '7Days' | 'Earlier';
  items: ChatSessionSummary[];
}

export const ICON_BASE_PATH = './assets/icons';
export const FIXTURE_NOW = new Date(2026, 7, 16, 12, 48, 0).getTime();
export const CHAT_MODEL: ChatModelOption = {
  id: 'qwen-3.5-9b-local',
  label: 'Qwen 3.5 9B · Local',
  source: 'local',
  isAvailable: true
};

export const ASSISTANT_FIXTURE =
  'This example creates a very simple, abstract life system simulation using C++.\n' +
  'It focuses on basic concepts like needs, actions, and state changes within a discrete time step loop.\n\n' +
  'Since it is "toy" and self-contained, we will use standard C++ features (classes, structs, std::cout, and basic loops).';

const DAY_MS = 24 * 60 * 60 * 1000;

function message(
  id: string,
  role: ChatMessageRole,
  content: string,
  createdAt: number,
  durationLabel: string | null = null
): ChatMessage {
  return { id, role, content, createdAt, durationLabel, status: 'complete' };
}

function conversation(
  id: string,
  title: string,
  updatedAt: number,
  userText = 'Please write an example self contained toy lifesystem in C++'
): ChatSession {
  return {
    id,
    title,
    createdAt: updatedAt - 60_000,
    updatedAt,
    messages: [
      message(`${id}-user`, 'user', userText, updatedAt - 45_000),
      message(`${id}-assistant`, 'assistant', ASSISTANT_FIXTURE, updatedAt, '12:48')
    ]
  };
}

export function createBlankSession(id: string, createdAt = FIXTURE_NOW): ChatSession {
  return { id, title: 'New Private Chat', createdAt, updatedAt: createdAt, messages: [] };
}

/** Initial renderer-only data mirrors the Figma conversation and history examples. */
export function createChatFixture(): ChatSession[] {
  return [
    conversation('daily-brief', 'Daily Brief 2026-08-16 derf', FIXTURE_NOW - 2 * DAY_MS),
    conversation('wechat-motivation', 'When I open WeChat chat motivation', FIXTURE_NOW),
    conversation('vendio', 'Vendio', FIXTURE_NOW),
    conversation('get-info', 'Get Info', FIXTURE_NOW, 'Get Info'),
    conversation('change-wallpaper', 'Change Wallpaper...', FIXTURE_NOW, 'Change Wallpaper...'),
    conversation('crash-recovery', 'Crash Recovery for Desktop App', FIXTURE_NOW - 3 * DAY_MS),
    conversation('memory-history', 'Memory and Chat History...', FIXTURE_NOW - 4 * DAY_MS),
    conversation('twitter-badge', 'Twitter Premium Blue Badge Guide', FIXTURE_NOW - 5 * DAY_MS),
    conversation('agent-product', 'Choosing Agent Product for Chat Window', FIXTURE_NOW - 6 * DAY_MS),
    conversation('older-one', 'A longer conversation from last month', FIXTURE_NOW - 14 * DAY_MS),
    conversation('older-two', 'Planning local model experiments', FIXTURE_NOW - 21 * DAY_MS),
    conversation('older-three', 'Desktop runtime notes', FIXTURE_NOW - 28 * DAY_MS),
    conversation('older-four', 'Ideas for a private workspace', FIXTURE_NOW - 35 * DAY_MS)
  ];
}

export function summarizeSession(session: ChatSession): ChatSessionSummary {
  const lastMessage = session.messages[session.messages.length - 1];
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    preview: lastMessage?.content ?? null
  };
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function getHistoryGroup(summary: ChatSessionSummary, now: number): ChatHistoryGroup['label'] {
  const ageInDays = Math.floor((startOfLocalDay(now) - startOfLocalDay(summary.updatedAt)) / DAY_MS);
  if (localDateKey(summary.updatedAt) === localDateKey(now)) return 'Today';
  if (ageInDays >= 0 && ageInDays < 7) return '7Days';
  return 'Earlier';
}

export function groupHistory(summaries: readonly ChatSessionSummary[], now: number): ChatHistoryGroup[] {
  const order: ChatHistoryGroup['label'][] = ['Today', '7Days', 'Earlier'];
  return order.flatMap((label) => {
    const items = summaries
      .filter((summary) => getHistoryGroup(summary, now) === label)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return items.length > 0 ? [{ label, items }] : [];
  });
}

export function searchHistory(
  summaries: readonly ChatSessionSummary[],
  query: string
): ChatSessionSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  return summaries
    .filter((summary) => summary.title.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function paginateEarlier(
  summaries: readonly ChatSessionSummary[],
  now: number,
  page: number,
  pageSize: number
): { items: ChatSessionSummary[]; hasNextPage: boolean } {
  const earlier = summaries
    .filter((summary) => getHistoryGroup(summary, now) === 'Earlier')
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const start = Math.max(0, page) * pageSize;
  return { items: earlier.slice(start, start + pageSize), hasNextPage: start + pageSize < earlier.length };
}

export function formatConversationDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

export function getTitleMatchParts(title: string, query: string): { text: string; matches: boolean }[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [{ text: title, matches: false }];
  const start = title.toLocaleLowerCase().indexOf(normalizedQuery.toLocaleLowerCase());
  if (start < 0) return [{ text: title, matches: false }];
  return [
    { text: title.slice(0, start), matches: false },
    { text: title.slice(start, start + normalizedQuery.length), matches: true },
    { text: title.slice(start + normalizedQuery.length), matches: false }
  ].filter((part) => part.text.length > 0);
}

export function formatHistoryTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp);
}

export function messagePreview(content: string): ReactNode {
  return content.length > 80 ? `${content.slice(0, 77)}…` : content;
}
