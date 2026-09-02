import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import CountdownTimer from '../../shared/CountdownTimer';
import { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';
import { useAccount } from '../components/AccountProvider';
import { PageShell } from '../components/PageShell';

type SignInStep = 'credentials' | 'verification';
type BusyAction = 'google' | 'emailCode' | 'verification' | 'signOut' | null;

const SIGN_IN_ICON = `${ICON_BASE_PATH}/account-signin.svg`;
const GOOGLE_ICON = `${ICON_BASE_PATH}/account-google.svg`;
const EMAIL_CODE_RESEND_COUNTDOWN = new CountdownTimer(60);

/** Account page workflow for Google OAuth and six-digit email verification. */
export function SignInPage() {
  const account = useAccount();
  const [step, setStep] = useState<SignInStep>('credentials');
  const [emailAddress, setEmailAddress] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [resendDeadlineMs, setResendDeadlineMs] = useState<number | null>(null);
  const [resendSecondsRemaining, setResendSecondsRemaining] = useState(0);
  const submittedCode = useRef<string | null>(null);
  const isGooglePending = useRef(false);

  useEffect(() => {
    return () => {
      if (isGooglePending.current) void account.cancelGoogleSignIn();
    };
  }, [account]);

  useEffect(() => {
    if (step !== 'verification' || resendDeadlineMs === null) return;

    // Derive every tick from the deadline because background windows may throttle timers.
    const intervalId = window.setInterval(() => {
      const secondsRemaining = EMAIL_CODE_RESEND_COUNTDOWN.getSecondsRemaining(resendDeadlineMs);
      setResendSecondsRemaining(secondsRemaining);
      if (secondsRemaining === 0) window.clearInterval(intervalId);
    }, 1_000);

    return () => window.clearInterval(intervalId);
  }, [resendDeadlineMs, step]);

  const showResult = useCallback((result: { ok: boolean; error?: { message: string } }): boolean => {
    if (result.ok) {
      setMessage(null);
      setIsError(false);
      return true;
    }
    setMessage(result.error?.message ?? 'Authentication is temporarily unavailable.');
    setIsError(true);
    return false;
  }, []);

  const requestEmailCode = useCallback(async () => {
    if (!emailAddress.trim() || busyAction || (step === 'verification' && resendSecondsRemaining > 0)) return;
    setBusyAction('emailCode');
    setMessage(null);
    const result = await account.requestEmailCode(emailAddress);
    if (showResult(result)) {
      const deadlineMs = EMAIL_CODE_RESEND_COUNTDOWN.start();
      setStep('verification');
      setVerificationCode('');
      setResendDeadlineMs(deadlineMs);
      setResendSecondsRemaining(EMAIL_CODE_RESEND_COUNTDOWN.getSecondsRemaining(deadlineMs));
      submittedCode.current = null;
      setMessage('Verification code sent.');
    }
    setBusyAction(null);
  }, [account, busyAction, emailAddress, resendSecondsRemaining, showResult, step]);

  const verifyEmail = useCallback(async (code: string) => {
    if (busyAction || code.length !== 6) return;
    setBusyAction('verification');
    setMessage('Verifying email...');
    setIsError(false);
    const result = await account.verifyEmail(emailAddress, code);
    showResult(result);
    setBusyAction(null);
  }, [account, busyAction, emailAddress, showResult]);

  useEffect(() => {
    if (
      step === 'verification' &&
      verificationCode.length === 6 &&
      submittedCode.current !== verificationCode &&
      !busyAction
    ) {
      submittedCode.current = verificationCode;
      void verifyEmail(verificationCode);
    }
  }, [busyAction, step, verificationCode, verifyEmail]);

  const updateVerificationCode = (value: string): void => {
    const nextCode = value.replace(/\D/g, '').slice(0, 6);
    if (nextCode.length < 6) submittedCode.current = null;
    setVerificationCode(nextCode);
    setMessage(null);
    setIsError(false);
  };

  const signInWithGoogle = async (): Promise<void> => {
    if (busyAction) return;
    setBusyAction('google');
    setMessage('Finish sign-in in your browser.');
    setIsError(false);
    isGooglePending.current = true;
    const result = await account.signInWithGoogle();
    isGooglePending.current = false;
    showResult(result);
    setBusyAction(null);
  };

  const signOut = async (): Promise<void> => {
    if (busyAction) return;
    setBusyAction('signOut');
    setMessage(null);
    const result = await account.signOut();
    showResult(result);
    setBusyAction(null);
  };

  const handleEmailSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void requestEmailCode();
  };

  return (
    <PageShell
      title="Account"
      subtitle="Sign in to manage your Tokkey account and services."
      testId="sign-in"
    >
      <section className="flex min-h-0 flex-1 items-center justify-center overflow-auto py-2" data-testid="sign-in-pane">
        {account.state.status === 'authenticated' ? (
          <SignedInAccount
            displayName={account.state.profile.displayName}
            email={account.state.profile.email}
            isBusy={busyAction === 'signOut'}
            message={message}
            isError={isError}
            onSignOut={() => void signOut()}
          />
        ) : (
          <div className="flex w-full max-w-[430px] flex-col items-center gap-4">
            <SignInHeading />
            {step === 'credentials' ? (
              <CredentialsForm
                emailAddress={emailAddress}
                busyAction={busyAction}
                isRestoring={account.isRestoring}
                message={message ?? account.restoreError ?? (account.isRestoring ? 'Restoring account...' : null)}
                isError={isError || Boolean(account.restoreError)}
                onEmailChange={setEmailAddress}
                onEmailSubmit={handleEmailSubmit}
                onGoogleSignIn={() => void signInWithGoogle()}
              />
            ) : (
              <VerificationForm
                emailAddress={emailAddress.trim().toLowerCase()}
                verificationCode={verificationCode}
                busyAction={busyAction}
                resendSecondsRemaining={resendSecondsRemaining}
                message={message}
                isError={isError}
                onCodeChange={updateVerificationCode}
                onBack={() => {
                  setStep('credentials');
                  setResendDeadlineMs(null);
                  setResendSecondsRemaining(0);
                  setMessage(null);
                  setIsError(false);
                }}
                onResend={() => void requestEmailCode()}
              />
            )}
          </div>
        )}
      </section>
    </PageShell>
  );
}

/** Shared heading keeps both signed-out steps geometrically stable. */
function SignInHeading() {
  return (
    <>
      <div className="flex size-12 shrink-0 items-center justify-center rounded-[8px] bg-account-icon">
        <img className="block size-[21px] max-w-none" src={SIGN_IN_ICON} alt="" />
      </div>
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-[20px] leading-6 font-bold text-account-heading">Sign in to Tokkey</h2>
        <p className="text-[13px] leading-4 text-label-eyebrow">
          Use email or Google to access your account.
        </p>
      </div>
    </>
  );
}

interface CredentialsFormProps {
  emailAddress: string;
  busyAction: BusyAction;
  isRestoring: boolean;
  message: string | null;
  isError: boolean;
  onEmailChange: (value: string) => void;
  onEmailSubmit: (event: FormEvent) => void;
  onGoogleSignIn: () => void;
}

/** First sign-in step with provider and normalized email entry paths. */
function CredentialsForm({
  emailAddress,
  busyAction,
  isRestoring,
  message,
  isError,
  onEmailChange,
  onEmailSubmit,
  onGoogleSignIn
}: CredentialsFormProps) {
  const isBusy = busyAction !== null || isRestoring;
  return (
    <form
      className="flex w-full flex-col items-center gap-3 rounded-[8px] border border-surface-panel-border bg-white p-4"
      onSubmit={onEmailSubmit}
      data-testid="sign-in-form"
    >
      <button
        type="button"
        className="flex h-[43px] w-full items-center justify-center gap-2 rounded-[6px] border border-account-control-border bg-field-bg px-3 text-[13px] leading-4 font-semibold text-account-control focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40"
        onClick={onGoogleSignIn}
        disabled={isBusy}
        data-testid="continue-with-google"
      >
        <img className="block size-4 max-w-none" src={GOOGLE_ICON} alt="" />
        {busyAction === 'google' ? 'Waiting for Google...' : 'Continue with Google'}
      </button>

      <div className="flex w-full items-center gap-2.5" aria-hidden="true">
        <span className="h-px min-w-0 flex-1 bg-dialog-divider" />
        <span className="shrink-0 text-[11px] leading-[13px] text-label-eyebrow">or</span>
        <span className="h-px min-w-0 flex-1 bg-dialog-divider" />
      </div>

      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
        <input
          className="h-[34px] min-w-0 select-text rounded-[6px] border border-transparent bg-field-bg px-3 text-[13px] leading-4 text-account-control outline-none placeholder:text-field-placeholder focus:border-selected-ink focus:ring-1 focus:ring-selected-ink/20 disabled:opacity-40"
          type="email"
          value={emailAddress}
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="Email address"
          aria-label="Email address"
          autoComplete="email"
          spellCheck={false}
          autoFocus
          disabled={isBusy}
          data-testid="email-input"
        />
        <button
          type="submit"
          className="h-[34px] rounded-[6px] bg-selected-ink px-3 text-[12px] leading-4 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40"
          disabled={!emailAddress.trim() || isBusy}
          data-testid="send-email-code"
        >
          {busyAction === 'emailCode' ? 'Sending...' : 'Continue'}
        </button>
      </div>
      <StatusMessage message={message} isError={isError} />
    </form>
  );
}

interface VerificationFormProps {
  emailAddress: string;
  verificationCode: string;
  busyAction: BusyAction;
  resendSecondsRemaining: number;
  message: string | null;
  isError: boolean;
  onCodeChange: (value: string) => void;
  onBack: () => void;
  onResend: () => void;
}

/** Six-digit step; completion is submitted automatically by the page owner. */
function VerificationForm({
  emailAddress,
  verificationCode,
  busyAction,
  resendSecondsRemaining,
  message,
  isError,
  onCodeChange,
  onBack,
  onResend
}: VerificationFormProps) {
  const isBusy = busyAction !== null;
  const isResendCoolingDown = resendSecondsRemaining > 0;
  const resendLabel = isResendCoolingDown
    ? `Resend in ${resendSecondsRemaining}s`
    : 'Resend code';
  return (
    <div className="flex w-full flex-col gap-4 rounded-[8px] border border-surface-panel-border bg-white p-4" data-testid="verification-form">
      <div className="flex flex-col gap-1">
        <h3 className="text-[14px] leading-[17px] font-bold text-account-heading">Email verification</h3>
        <p className="break-words text-[12px] leading-4 text-label-eyebrow">
          Enter the code sent to {emailAddress}.
        </p>
      </div>
      <input
        className="h-[42px] w-full select-text rounded-[6px] border border-account-control-border bg-field-bg px-3 text-center font-mono text-[18px] leading-6 text-account-control outline-none focus:border-selected-ink focus:ring-1 focus:ring-selected-ink/20 disabled:opacity-40"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={verificationCode}
        onChange={(event) => onCodeChange(event.target.value)}
        aria-label="Six-digit verification code"
        autoComplete="one-time-code"
        autoFocus
        disabled={isBusy}
        data-testid="verification-code-input"
      />
      <StatusMessage message={message} isError={isError} />
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="text-[11px] leading-[13px] font-medium text-label-eyebrow focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40"
          onClick={onBack}
          disabled={isBusy}
          data-testid="verification-back"
        >
          Change email
        </button>
        <button
          type="button"
          className="w-[104px] rounded-[6px] bg-field-bg px-2 py-2 text-[11px] leading-[13px] font-medium text-account-control focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40"
          onClick={onResend}
          disabled={isBusy || isResendCoolingDown}
          data-testid="verification-resend"
        >
          {busyAction === 'emailCode' ? 'Sending...' : resendLabel}
        </button>
      </div>
    </div>
  );
}

interface SignedInAccountProps {
  displayName: string | null;
  email: string;
  isBusy: boolean;
  message: string | null;
  isError: boolean;
  onSignOut: () => void;
}

/** Authenticated account presentation, without access to any credential fields. */
function SignedInAccount({ displayName, email, isBusy, message, isError, onSignOut }: SignedInAccountProps) {
  const resolvedName = displayName?.trim() || 'Tokkey User';
  const initial = resolvedName.charAt(0).toUpperCase();
  return (
    <div className="flex w-full max-w-[430px] flex-col items-center gap-4 rounded-[8px] border border-surface-panel-border bg-white p-6" data-testid="signed-in-account">
      <span className="flex size-16 items-center justify-center rounded-full border border-account-control-border bg-field-bg text-[24px] leading-7 font-semibold text-account-control">
        {initial}
      </span>
      <div className="flex min-w-0 flex-col items-center gap-1 text-center">
        <h2 className="max-w-full truncate text-[16px] leading-5 font-bold text-account-heading">{resolvedName}</h2>
        <p className="max-w-full truncate text-[12px] leading-4 text-label-eyebrow" data-testid="account-email">{email}</p>
      </div>
      <StatusMessage message={message} isError={isError} />
      <button
        type="button"
        className="rounded-[6px] bg-field-bg px-4 py-2 text-[12px] leading-4 font-medium text-account-control focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40"
        onClick={onSignOut}
        disabled={isBusy}
        data-testid="sign-out-account"
      >
        {isBusy ? 'Signing out...' : 'Sign out'}
      </button>
    </div>
  );
}

/** Reserves one line so async notices cannot resize the sign-in control. */
function StatusMessage({ message, isError }: { message: string | null; isError: boolean }) {
  return (
    <p
      className={`min-h-[14px] w-full text-center text-[11px] leading-[14px] ${isError ? 'text-status-error-text' : 'text-label-eyebrow'}`}
      role={isError ? 'alert' : 'status'}
      data-testid="account-status"
    >
      {message ?? ''}
    </p>
  );
}
