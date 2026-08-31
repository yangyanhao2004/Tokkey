/** One normalized payload parsed from an OpenAI-compatible chat completion stream. */
export type ParsedChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null }
  | { type: 'completed' }
  | { type: 'error'; message: string };

type UnknownRecord = Record<string, unknown>;

/**
 * Incrementally parses OpenAI Chat Completions SSE frames without assuming a
 * network chunk matches an SSE frame. Unknown provider metadata is ignored so
 * compatible local servers can add fields without breaking the transcript.
 */
export class OpenAiChatSseParser {
  private lineBuffer = '';
  private eventDataLines: string[] = [];

  push(chunk: string): ParsedChatStreamEvent[] {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? '';
    return lines.flatMap((line) => this.consumeLine(line));
  }

  finish(): ParsedChatStreamEvent[] {
    const events = this.lineBuffer.length > 0 ? this.consumeLine(this.lineBuffer) : [];
    this.lineBuffer = '';
    return [...events, ...this.flushEvent()];
  }

  private consumeLine(line: string): ParsedChatStreamEvent[] {
    if (line.length === 0) {
      return this.flushEvent();
    }
    if (line.startsWith('data:')) {
      this.eventDataLines = [
        ...this.eventDataLines,
        line.slice(5).trimStart()
      ];
    }
    return [];
  }

  private flushEvent(): ParsedChatStreamEvent[] {
    if (this.eventDataLines.length === 0) {
      return [];
    }
    const payload = this.eventDataLines.join('\n').trim();
    this.eventDataLines = [];
    if (!payload) {
      return [];
    }
    if (payload === '[DONE]') {
      return [{ type: 'completed' }];
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(payload);
    } catch {
      return [{ type: 'error', message: 'The local model sent an invalid streaming response.' }];
    }
    if (!isRecord(decoded)) {
      return [];
    }
    const error = readRecord(decoded.error);
    if (error) {
      return [{ type: 'error', message: readString(error.message) ?? 'The local model reported an error.' }];
    }

    const events: ParsedChatStreamEvent[] = [];
    const choices = decoded.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const delta = readRecord(choice)?.delta;
        const text = readString(readRecord(delta)?.content);
        if (text) {
          events.push({ type: 'text', text });
        }
      }
    }
    const usage = readRecord(decoded.usage);
    if (usage) {
      const inputTokens = readNumber(usage.prompt_tokens) ?? readNumber(usage.input_tokens);
      const outputTokens = readNumber(usage.completion_tokens) ?? readNumber(usage.output_tokens);
      if (inputTokens !== null || outputTokens !== null) {
        events.push({ type: 'usage', inputTokens, outputTokens });
      }
    }
    return events;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export default OpenAiChatSseParser;
