import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { decideApproval } from "../lib/api";

/**
 * The maker-checker decision control: a reason field plus Approve / Reject.
 * Used both in the approvals inbox and inline at the gate in the run viewer,
 * so a reviewer can sign off where they read the evidence. A reason is required
 * to reject and is recorded verbatim in the audit log. On success every query
 * is invalidated so the run, the inbox, and the chain badge all refresh.
 */
export function ApprovalDecision({
  approvalId,
  stepKey,
  onDecided,
}: {
  approvalId: string;
  stepKey: string;
  onDecided?: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      decideApproval(approvalId, decision, reason.trim() === "" ? undefined : reason.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onDecided?.();
    },
  });

  const submit = (decision: "approved" | "rejected") => {
    if (decision === "rejected" && reason.trim() === "") {
      setValidationError("A reason is required to reject.");
      return;
    }
    setValidationError(null);
    decide.mutate(decision);
  };

  return (
    <div>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required to reject, recorded verbatim in the audit log)"
        aria-label={`Reason for ${stepKey}`}
        rows={2}
        className="w-full rounded border border-line bg-paper px-2.5 py-1.5 text-sm"
      />
      {validationError && (
        <p className="mt-1 text-xs font-medium text-blocked" role="alert">
          {validationError}
        </p>
      )}
      {decide.isError && (
        <p className="mt-1 text-xs font-medium text-blocked" role="alert">
          Decision failed: {decide.error instanceof Error ? decide.error.message : "error"}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => submit("approved")}
          className="rounded border border-verified bg-verified px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => submit("rejected")}
          className="rounded border border-blocked bg-white px-3 py-1.5 text-xs font-medium text-blocked disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
