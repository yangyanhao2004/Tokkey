import LocalModel from './LocalModel';

/**
 * Whether a local model is currently published to the CLIs, and which.
 *
 * The exact counterpart of {@link ../router/RouterBinding.RouterBinding}, and
 * kept separate from it on purpose: the router's switch and the local model's
 * lifecycle move independently, so folding both into one object would make
 * "the router is on" and "a local model is running" share a state they can
 * disagree about. Each binding answers one question; the two CLI integrations
 * read both on every write.
 *
 * Unlike the router's binding this carries no base URL. A local model is always
 * reached at whatever address the CLIs are already pointed at — the gateway
 * serves its route directly, and the router forwards a name it does not
 * recognize to that same gateway — so publishing one never moves an endpoint.
 *
 * Mutable for the same reason `RouterBinding` is: every reader wants the value
 * as it stands now, not as it stood when the reader was constructed.
 */
export class LocalModelBinding {
  private published: LocalModel | null = null;

  /** Offers `model` in both pickers. */
  bind(model: LocalModel): void {
    this.published = model;
  }

  /** Takes the local row back out of both pickers. */
  release(): void {
    this.published = null;
  }

  get isBound(): boolean {
    return this.published !== null;
  }

  /** The local model to publish, or null when there is nothing to publish. */
  get model(): LocalModel | null {
    return this.published;
  }
}

export default LocalModelBinding;
