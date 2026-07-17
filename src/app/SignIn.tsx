import { useState } from "react";
import { useAuthStore } from "@/state/authStore";
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
        <h1 className="signin-greeting">Juno</h1>
        <p className="signin-subtitle">Your assistant, on this PC.</p>

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
              Sign in with your browser
            </button>
            <p className="signin-hint">
              Uses your existing Juno account — conversations, projects and memory stay in sync
              with the web and Mac apps.
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
