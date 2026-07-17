/** Data & account: profile, export, destructive resets, sign out, delete account. */
import { useState } from "react";
import { api } from "@/lib/backend/http";
import { useAuthStore } from "@/state/authStore";
import { useDataStore } from "@/state/dataStore";
import { SectionTitle, SettingRow } from "./controls";

function downloadJson(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function AccountSection() {
  const profile = useAuthStore((s) => s.profile);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [memoryArmed, setMemoryArmed] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);

  const [wipeArmed, setWipeArmed] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState("");
  const [wipeBusy, setWipeBusy] = useState(false);
  const [wipeError, setWipeError] = useState<string | null>(null);

  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [signingOut, setSigningOut] = useState(false);

  const exportData = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const data = await api<unknown>("/account/export");
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(data, `juno-export-${stamp}.json`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  const resetMemory = async () => {
    setMemoryBusy(true);
    setMemoryError(null);
    try {
      await api("/memory", { method: "DELETE" });
      useDataStore.getState().replaceMemories([], null);
      setMemoryArmed(false);
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : "Couldn't reset memory.");
    } finally {
      setMemoryBusy(false);
    }
  };

  const deleteAllConversations = async () => {
    setWipeBusy(true);
    setWipeError(null);
    try {
      await api("/conversations", { method: "DELETE" });
      useDataStore.getState().replaceConversations([]);
      setWipeArmed(false);
      setWipeConfirm("");
    } catch (err) {
      setWipeError(err instanceof Error ? err.message : "Couldn't delete conversations.");
    } finally {
      setWipeBusy(false);
    }
  };

  const deleteAccount = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api("/account/delete", { method: "POST", body: { confirmEmail: deleteEmail } });
      await useAuthStore.getState().signOut();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete the account.");
      setDeleteBusy(false);
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await useAuthStore.getState().signOut();
    } finally {
      setSigningOut(false);
    }
  };

  const emailMatches =
    profile !== null && deleteEmail.trim().toLowerCase() === profile.email.toLowerCase();

  return (
    <section className="settings-section" aria-label="Data and account">
      <SectionTitle>Data &amp; account</SectionTitle>

      <div className="settings-profile">
        {profile?.image ? (
          <img className="settings-avatar" src={profile.image} alt="" />
        ) : (
          <span className="settings-avatar settings-avatar-fallback" aria-hidden>
            {(profile?.name ?? profile?.email ?? "?").charAt(0).toUpperCase()}
          </span>
        )}
        <div className="settings-profile-text">
          <span className="settings-profile-name">{profile?.name ?? "Signed in"}</span>
          <span className="settings-profile-email">{profile?.email ?? ""}</span>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>

      <SettingRow
        label="Export data"
        hint="Download your conversations, memory, and settings as JSON."
      >
        <button
          type="button"
          className="btn btn-secondary"
          disabled={exporting}
          onClick={() => void exportData()}
        >
          {exporting ? "Exporting…" : "Export"}
        </button>
      </SettingRow>
      {exportError ? <p className="settings-error">{exportError}</p> : null}

      <SettingRow
        label="Reset memory"
        hint="Erases everything Juno remembers. This can't be undone."
      >
        {!memoryArmed ? (
          <button type="button" className="btn btn-secondary" onClick={() => setMemoryArmed(true)}>
            Reset
          </button>
        ) : null}
      </SettingRow>
      {memoryArmed ? (
        <div className="settings-confirm">
          <p>Erase everything Juno remembers? Past chats won't be re-learned.</p>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setMemoryArmed(false);
                setMemoryError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              disabled={memoryBusy}
              onClick={() => void resetMemory()}
            >
              {memoryBusy ? "Erasing…" : "Erase memory"}
            </button>
          </div>
          {memoryError ? <p className="settings-error">{memoryError}</p> : null}
        </div>
      ) : null}

      <SettingRow
        label="Delete all conversations"
        hint="Permanently removes every conversation and its messages."
      >
        {!wipeArmed ? (
          <button type="button" className="btn btn-secondary" onClick={() => setWipeArmed(true)}>
            Delete all
          </button>
        ) : null}
      </SettingRow>
      {wipeArmed ? (
        <div className="settings-confirm">
          <p>
            Type <strong>delete</strong> to confirm. Every conversation will be permanently
            removed.
          </p>
          <input
            type="text"
            value={wipeConfirm}
            onChange={(e) => setWipeConfirm(e.target.value)}
            aria-label="Type delete to confirm"
            placeholder="delete"
          />
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setWipeArmed(false);
                setWipeConfirm("");
                setWipeError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              disabled={wipeBusy || wipeConfirm.trim().toLowerCase() !== "delete"}
              onClick={() => void deleteAllConversations()}
            >
              {wipeBusy ? "Deleting…" : "Delete all conversations"}
            </button>
          </div>
          {wipeError ? <p className="settings-error">{wipeError}</p> : null}
        </div>
      ) : null}

      <div className="settings-danger">
        <h4 className="settings-danger-title">Danger zone</h4>
        <SettingRow
          label="Delete account"
          hint="Permanently deletes your account, conversations, memory, and files."
        >
          {!deleteArmed ? (
            <button
              type="button"
              className="btn btn-destructive"
              onClick={() => setDeleteArmed(true)}
            >
              Delete account
            </button>
          ) : null}
        </SettingRow>
        {deleteArmed ? (
          <div className="settings-confirm">
            <p>
              This deletes your account and everything in it, immediately and permanently. Type
              your account email to confirm.
            </p>
            <input
              type="email"
              value={deleteEmail}
              onChange={(e) => setDeleteEmail(e.target.value)}
              aria-label="Type your account email to confirm"
              placeholder={profile?.email ?? "you@example.com"}
            />
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setDeleteArmed(false);
                  setDeleteEmail("");
                  setDeleteError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-destructive"
                disabled={deleteBusy || !emailMatches}
                onClick={() => void deleteAccount()}
              >
                {deleteBusy ? "Deleting…" : "Permanently delete account"}
              </button>
            </div>
            {deleteError ? <p className="settings-error">{deleteError}</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
