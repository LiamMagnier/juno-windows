/**
 * Modal approval sheet for gated agent actions. Deny is the default focus
 * (the body has no button/input, so the Dialog autofocus lands on the first
 * footer button); Escape denies; "Allow always" is hidden for sensitive
 * actions — those must confirm every time.
 */
import { useMemo } from "react";
import { ShieldAlert } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { ApprovalDecision, ApprovalRequest } from "@/lib/code/types";

export function ApprovalSheet({
  request,
  onResolve,
}: {
  request: ApprovalRequest;
  onResolve(decision: ApprovalDecision): void;
}) {
  const sensitive = request.risk === "sensitive";

  const detail = useMemo(() => {
    try {
      return JSON.stringify(request.input, null, 2);
    } catch {
      return String(request.input);
    }
  }, [request.input]);

  return (
    <Dialog
      title={sensitive ? "Sensitive action" : "Approve this command?"}
      open
      onClose={() => onResolve("deny")}
      width={480}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={() => onResolve("deny")}>
            Deny
          </button>
          {!sensitive ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onResolve("allow_always")}
            >
              Allow always
            </button>
          ) : null}
          <button
            type="button"
            className={sensitive ? "btn btn-destructive" : "btn btn-primary"}
            onClick={() => onResolve("allow")}
          >
            Allow once
          </button>
        </>
      }
    >
      {sensitive ? (
        <div className="code-approval-risk" role="alert">
          <ShieldAlert size={16} aria-hidden />
          <span>
            Juno flagged this as sensitive — it always asks before actions like this, in every
            mode.
          </span>
        </div>
      ) : null}
      <div className="code-approval-summary selectable" data-risk={request.risk}>
        {request.summary}
      </div>
      <details className="code-approval-detail">
        <summary>Input detail</summary>
        <pre className="code-mono selectable">{detail}</pre>
      </details>
      <p className="code-approval-hint">
        Tool: <span className="code-mono-inline">{request.toolName}</span> · Escape denies
      </p>
    </Dialog>
  );
}
