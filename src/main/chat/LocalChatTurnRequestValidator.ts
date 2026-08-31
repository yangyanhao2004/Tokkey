import type { LocalChatMessageInput, LocalChatTurnRequest } from '../../shared/types';

const MAX_CHAT_TURN_ID_LENGTH = 128;
const MAX_CHAT_SESSION_ID_LENGTH = 128;
const MAX_CHAT_MESSAGE_ID_LENGTH = 128;
const MAX_CHAT_MODEL_ID_LENGTH = 256;
const MAX_CHAT_MESSAGES = 80;
const MAX_CHAT_MESSAGE_LENGTH = 32_000;
const MAX_CHAT_REQUEST_BYTES = 160_000;

type UnknownRecord = Record<string, unknown>;

/**
 * Narrows a renderer request to the small, local-only chat contract. The main
 * process chooses the model's endpoint and process arguments; neither can be
 * supplied through this boundary.
 */
export function validateLocalChatTurnRequest(value: unknown): LocalChatTurnRequest {
  const request = requireRecord(value, 'Local Chat request');
  requireOnlyRequestFields(request);
  const messages = requireMessages(request.messages);
  const requestBytes = messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
    0
  );
  if (requestBytes > MAX_CHAT_REQUEST_BYTES) {
    throw new RangeError(`Local Chat request cannot exceed ${MAX_CHAT_REQUEST_BYTES} bytes.`);
  }

  return {
    turnId: requireBoundedString(request.turnId, 'Chat turn ID', MAX_CHAT_TURN_ID_LENGTH),
    sessionId: requireBoundedString(request.sessionId, 'Chat session ID', MAX_CHAT_SESSION_ID_LENGTH),
    assistantMessageId: requireBoundedString(
      request.assistantMessageId,
      'Assistant message ID',
      MAX_CHAT_MESSAGE_ID_LENGTH
    ),
    modelId: requireBoundedString(request.modelId, 'Local model ID', MAX_CHAT_MODEL_ID_LENGTH),
    messages
  };
}

function requireOnlyRequestFields(request: UnknownRecord): void {
  const allowedFields = new Set(['turnId', 'sessionId', 'assistantMessageId', 'modelId', 'messages']);
  const unsupportedField = Object.keys(request).find((field) => !allowedFields.has(field));
  if (unsupportedField) {
    throw new TypeError(`Local Chat request cannot include ${unsupportedField}.`);
  }
}

/** Validates a cancellation target without accepting arbitrary-sized IPC input. */
export function validateLocalChatTurnId(value: unknown): string {
  return requireBoundedString(value, 'Chat turn ID', MAX_CHAT_TURN_ID_LENGTH);
}

function requireMessages(value: unknown): LocalChatMessageInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Local Chat messages must be a non-empty array.');
  }
  if (value.length > MAX_CHAT_MESSAGES) {
    throw new RangeError(`Local Chat supports at most ${MAX_CHAT_MESSAGES} messages per turn.`);
  }

  return value.map((message, index) => {
    const input = requireRecord(message, `Local Chat message ${index + 1}`);
    if (input.role !== 'user' && input.role !== 'assistant') {
      throw new TypeError(`Local Chat message ${index + 1} has an unsupported role.`);
    }
    return {
      role: input.role,
      content: requireBoundedString(
        input.content,
        `Local Chat message ${index + 1} content`,
        MAX_CHAT_MESSAGE_LENGTH
      )
    };
  });
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function requireBoundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (value.length > maximumLength) {
    throw new RangeError(`${label} cannot exceed ${maximumLength} characters.`);
  }
  return value;
}
