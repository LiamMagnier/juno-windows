import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { useAuthStore } from "@/state/authStore";
import { DotMatrixMark } from "@/components/signature/DotMatrix";
import {
  backendEnvironment,
  setBackendEnvironment,
  type BackendEnvironment,
} from "@/lib/backend/config";
import "./signin.css";

/**
 * Device sign-in. The account lives in the browser: we hand off to
 * <backend>/app-auth and wait for the juno:// callback.
 */
export function SignIn() {
  const { status, error, signIn, cancelSignIn } = useAuthStore();
  const [environment, setEnvironment] = useState<BackendEnvironment>(backendEnvironment());
  const authorizing = status === "authorizing";

  const switchEnvironment = (env: BackendEnvironment) => {
    setBackendEnvironment(env);
    setEnvironment(env);
  };

  return (
    <main className="signin" aria-busy={authorizing}>
      <div className="signin-card">
        <div className="signin-mark" aria-hidden><DotMatrixMark size={34} /></div>
        <h1 className="signin-greeting">Juno</h1>
        <p className="signin-subtitle">One calm place to think, create, and get work done.</p>

        {authorizing ? (
          <div className="signin-waiting" role="status">
            <div className="signin-spinner" aria-hidden="true" />
            <p>Finish signing in from your browser.</p>
            <p className="signin-hint">We'll bring you back here automatically.</p>
            <button type="button" className="signin-secondary" onClick={cancelSignIn}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button type="button" className="signin-primary" onClick={() => void signIn()}>
              Continue in browser
              <ArrowRight size={16} aria-hidden />
            </button>
            <div className="signin-benefits" aria-label="Your data stays in sync">
              <span><Check size={13} aria-hidden /> Conversations</span>
              <span><Check size={13} aria-hidden /> Projects</span>
              <span><Check size={13} aria-hidden /> Memory</span>
            </div>
            <p className="signin-hint">
              Sign in securely with your existing Juno account. Your workspace stays in sync
              across Windows, web, and Mac.
            </p>
          </>
        )}

        {error ? (
          <p className="signin-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="signin-footer">
        <label className="signin-env">
          <span>Backend</span>
          <select
            value={environment}
            onChange={(e) => switchEnvironment(e.target.value as BackendEnvironment)}
            disabled={authorizing}
          >
            <option value="production">Production</option>
            <option value="local">Local (localhost:3000)</option>
          </select>
        </label>
      </footer>
    </main>
  );
}
