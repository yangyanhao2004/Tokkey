import type {
  LocalChatEvent,
  LocalChatTurnRequest,
  LocalChatTurnStarted
} from '../../shared/types';
import type { LocalInferenceRuntimeServing } from '../local-inference/LocalInferenceProcessManager';
import OpenAiChatSseParser, { type ParsedChatStreamEvent } from './OpenAiChatSseParser';

export type LocalChatFetch = (input: string, init: RequestInit) => Promise<Response>;

interface ActiveLocalChatTurn {
  abortController: AbortController;
  emit: (event: LocalChatEvent) => void;
  terminalSent: boolean;
  request: LocalChatTurnRequest;
}

type LocalChatDeltaEvent =
  | { type: 'textDelta'; text: string }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null };

type LocalChatTerminalEvent =
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'error'; message: string; retryable: boolean };

/**
 * Executes one direct, local-model-only Chat turn. It owns cancellation and
 * converts an OpenAI-compatible SSE response into renderer-safe chat events.
 */
export class LocalChatTurnExecutor {
  private readonly runtime: LocalInferenceRuntimeServing;
  private readonly fetcher: LocalChatFetch;
  private readonly activeTurns = new Map<string, ActiveLocalChatTurn>();

  constructor(options: { runtime: LocalInferenceRuntimeServing; fetcher?: LocalChatFetch }) {
    this.runtime = options.runtime;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  /** Starts background streaming after checking that the requested local model is ready. */
  startTurn(
    request: LocalChatTurnRequest,
    onEvent: (event: LocalChatEvent) => void
  ): LocalChatTurnStarted {
    if (this.activeTurns.has(request.turnId)) {
      throw new Error(`Chat turn ${request.turnId} is already running.`);
    }
    const endpoint = this.runtime.chatCompletionsUrl(request.modelId);
    this.requireLoopbackEndpoint(endpoint);

    const activeTurn: ActiveLocalChatTurn = {
      abortController: new AbortController(),
      emit: onEvent,
      terminalSent: false,
      request
    };
    this.activeTurns.set(request.turnId, activeTurn);
    void this.streamTurn(activeTurn, endpoint);
    return { turnId: request.turnId };
  }

  /** Cancels one accepted turn. Repeated calls are harmless. */
  cancelTurn(turnId: string): void {
    const activeTurn = this.activeTurns.get(turnId);
    if (!activeTurn) {
      return;
    }
    activeTurn.abortController.abort();
    this.finish(activeTurn, { type: 'cancelled' });
  }

  private async streamTurn(activeTurn: ActiveLocalChatTurn, endpoint: string): Promise<void> {
    try {
      const response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A local server must not be allowed to turn a Chat request into a
        // request elsewhere through an HTTP redirect.
        redirect: 'error',
        signal: activeTurn.abortController.signal,
        body: JSON.stringify({
          model: activeTurn.request.modelId,
          stream: true,
          stream_options: { include_usage: true },
          messages: activeTurn.request.messages.map((message) => ({
            role: message.role,
            content: message.content
          }))
        })
      });
      if (!response.ok) {
        this.finish(activeTurn, {
          type: 'error',
          message: await this.describeResponseFailure(response),
          retryable: response.status >= 500
        });
        return;
      }
      if (!response.body) {
        this.finish(activeTurn, {
          type: 'error',
          message: 'The local model returned no response stream.',
          retryable: true
        });
        return;
      }

      const parser = new OpenAiChatSseParser();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!activeTurn.terminalSent) {
        const { done, value } = await reader.read();
        if (done) {
          for (const event of parser.finish()) {
            this.handleParsedEvent(activeTurn, event);
          }
          break;
        }
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          this.handleParsedEvent(activeTurn, event);
        }
      }
      if (!activeTurn.terminalSent) {
        this.finish(activeTurn, { type: 'completed' });
      }
    } catch (error) {
      if (activeTurn.abortController.signal.aborted) {
        this.finish(activeTurn, { type: 'cancelled' });
        return;
      }
      this.finish(activeTurn, {
        type: 'error',
        message: error instanceof Error ? error.message : 'The local model request failed.',
        retryable: true
      });
    }
  }

  private handleParsedEvent(activeTurn: ActiveLocalChatTurn, event: ParsedChatStreamEvent): void {
    switch (event.type) {
      case 'text':
        this.emit(activeTurn, { type: 'textDelta', text: event.text });
        return;
      case 'usage':
        this.emit(activeTurn, {
          type: 'usage',
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens
        });
        return;
      case 'completed':
        this.finish(activeTurn, { type: 'completed' });
        return;
      case 'error':
        this.finish(activeTurn, { type: 'error', message: event.message, retryable: false });
    }
  }

  private emit(
    activeTurn: ActiveLocalChatTurn,
    event: LocalChatDeltaEvent
  ): void {
    if (activeTurn.terminalSent) {
      return;
    }
    activeTurn.emit({
      ...event,
      turnId: activeTurn.request.turnId,
      sessionId: activeTurn.request.sessionId,
      assistantMessageId: activeTurn.request.assistantMessageId
    });
  }

  private finish(
    activeTurn: ActiveLocalChatTurn,
    terminal: LocalChatTerminalEvent
  ): void {
    if (activeTurn.terminalSent) {
      return;
    }
    activeTurn.terminalSent = true;
    this.activeTurns.delete(activeTurn.request.turnId);
    activeTurn.emit({
      ...terminal,
      turnId: activeTurn.request.turnId,
      sessionId: activeTurn.request.sessionId,
      assistantMessageId: activeTurn.request.assistantMessageId
    });
  }

  private async describeResponseFailure(response: Response): Promise<string> {
    const body = (await response.text()).trim();
    return body ? `The local model returned HTTP ${response.status}: ${body}` : `The local model returned HTTP ${response.status}.`;
  }

  private requireLoopbackEndpoint(endpoint: string): void {
    const url = new URL(endpoint);
    const isLoopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || !isLoopback) {
      throw new Error('Local Chat can only connect to an app-owned loopback inference runtime.');
    }
  }
}

export default LocalChatTurnExecutor;
