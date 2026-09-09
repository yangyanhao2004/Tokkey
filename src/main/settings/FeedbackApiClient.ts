import BackendEnvironment from '../config/BackendEnvironment';
import FeedbackError from './FeedbackErrors';

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Delivery seam for the "Send Feedback" dialog, so tests never touch the network. */
export interface FeedbackSubmitter {
  submit(feedback: string, email: string): Promise<void>;
}

/** The backend route one feedback message is posted to. */
export const FEEDBACK_ENDPOINT_PATH = '/api/v1/feedback';

/**
 * Posts one feedback message to the Amis backend.
 *
 * The dialog used to hand the message to the mail client, which left delivery
 * to whatever mail app the Mac happened to have. Posting keeps the send inside
 * the app, so the dialog can report success or failure truthfully.
 */
export default class FeedbackApiClient implements FeedbackSubmitter {
  private static readonly requestTimeoutMs = 15_000;

  private readonly origin: string;
  private readonly fetchImplementation: FetchImplementation;

  constructor(origin?: string, fetchImplementation: FetchImplementation = fetch) {
    this.origin = origin ?? process.env.TOKKEY_FEEDBACK_ORIGIN ?? BackendEnvironment.resolveOrigin();
    this.fetchImplementation = fetchImplementation;
  }

  /**
   * Posts one message, or throws a FeedbackError naming why it failed.
   *
   * The backend answers 202 on success and a non-2xx status on every failure,
   * so the status code alone decides the outcome. Both fields are required:
   * a blank email is refused with VALIDATION_FAILED.
   */
  async submit(feedback: string, email: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FeedbackApiClient.requestTimeoutMs);
    try {
      const response = await this.fetchImplementation(`${this.origin}${FEEDBACK_ENDPOINT_PATH}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, feedback }),
        signal: controller.signal
      });
      if (!response.ok) {
        // The backend's own code and message are logged, never shown: they are
        // written for API callers rather than for the person at the dialog.
        console.error(
          `[Feedback] Endpoint answered HTTP ${response.status}:`,
          await this.readEnvelopeCode(response)
        );
        throw FeedbackError.forStatus(response.status);
      }
    } catch (error) {
      if (error instanceof FeedbackError) throw error;
      // A timeout, a DNS failure or an unparseable answer all mean the same
      // thing to the user: the message did not get out.
      console.error('[Feedback] Sending feedback failed:', error);
      throw new FeedbackError('unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Best effort: a failure response is worth logging even when it is not JSON. */
  private async readEnvelopeCode(response: Response): Promise<string> {
    try {
      const envelope = (await response.json()) as { code?: unknown; message?: unknown } | null;
      return `${String(envelope?.code)} ${String(envelope?.message)}`;
    } catch {
      return '(unreadable body)';
    }
  }
}
