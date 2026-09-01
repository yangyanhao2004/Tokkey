import type { ReactNode } from 'react';

export type ChatMessageRole = 'user' | 'assistant';
export type ChatMessageStatus = 'complete' | 'streaming' | 'error';
export type ChatRequestState = 'idle' | 'sending' | 'error';
export type ChatModelState = 'available' | 'unavailable' | 'loading' | 'error';

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  reasoningContent: string;
  createdAt: number;
  durationLabel: string | null;
  status: ChatMessageStatus;
  tokenUsage: ChatTokenUsage | null;
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

export interface ChatTokenUsage {
  usedContextTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindowTokens: number;
}

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
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const LOCAL_HISTORY_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric'
});
const LOCAL_MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

interface CalendarDate {
  year: string;
  month: string;
  day: string;
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

function localCalendarDate(timestamp: number): CalendarDate {
  const parts = LOCAL_DATE_FORMATTER.formatToParts(new Date(timestamp));
  const valueFor = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    year: valueFor('year'),
    month: valueFor('month'),
    day: valueFor('day')
  };
}

function localDayIndex(timestamp: number): number {
  const { year, month, day } = localCalendarDate(timestamp);
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / DAY_MS;
}

export function getHistoryGroup(summary: ChatSessionSummary, now: number): ChatHistoryGroup['label'] {
  const ageInDays = Math.floor(localDayIndex(now) - localDayIndex(summary.updatedAt));
  if (ageInDays === 0) return 'Today';
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

export function formatConversationDate(timestamp: number): string {
  const { year, month, day } = localCalendarDate(timestamp);
  return `${year}.${month}.${day}`;
}

export function formatHistoryTime(timestamp: number): string {
  return LOCAL_HISTORY_TIME_FORMATTER.format(timestamp);
}

export function formatMessageTime(timestamp: number): string {
  return LOCAL_MESSAGE_TIME_FORMATTER.format(timestamp);
}

export function messagePreview(content: string): ReactNode {
  return content.length > 80 ? `${content.slice(0, 77)}…` : content;
}
