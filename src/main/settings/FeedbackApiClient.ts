import AccountConfiguration from '../account/AccountConfiguration';

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Delivery seam for the "Send Feedback" dialog, so tests never touch the network. */
export interface FeedbackSubmitter {
  submit(message: string, email?: string): Promise<void>;
}

/** The backend route one feedback message is posted to. */
export const FEEDBACK_ENDPOINT_PATH = '/api/v1/feedback';

/**
 * Posts one feedback message to the backend.
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
    this.origin =
      origin ?? process.env.TOKKEY_FEEDBACK_ORIGIN ?? AccountConfiguration.defaultOrigin;
    this.fetchImplementation = fetchImplementation;
  }

  async submit(message: string, email?: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FeedbackApiClient.requestTimeoutMs);
    try {
      const response = await this.fetchImplementation(`${this.origin}${FEEDBACK_ENDPOINT_PATH}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message, email: email ?? null }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Feedback endpoint answered HTTP ${response.status}`);
      }
    } catch (error) {
      console.error('[Feedback] Sending feedback failed:', error);
      throw new Error('Failed to send feedback');
    } finally {
      clearTimeout(timeout);
    }
  }
}
