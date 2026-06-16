import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import { ApprovalDecision } from "../components/ApprovalDecision";
import { EmptyNote, ErrorNote, Loading, PageTitle, RelTime } from "../components/ui";
import { listApprovals, type PendingApproval } from "../lib/api";

/** The maker-checker inbox: pending gates, decided inline with a reason. */
export function ApprovalsPage() {
  const query = useQuery({
    queryKey: ["approvals"],
    queryFn: listApprovals,
    refetchInterval: 5000,
  });

  if (query.isPending) return <Loading what="approvals" />;
  if (query.isError) return <ErrorNote error={query.error} />;

  return (
    <div>
      <PageTitle>Approvals</PageTitle>
      <div className="mt-6 space-y-4">
        {query.data.approvals.length === 0 ? (
          <EmptyNote>No pending approvals.</EmptyNote>
        ) : (
          query.data.approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))
        )}
      </div>
    </div>
  );
}

export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const navigate = useNavigate();
  return (
    <div className="rounded border border-line bg-white px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-ink">{approval.flow}</span>
        <span className="font-mono text-xs text-stone-500">{approval.step_key}</span>
        <span className="text-xs text-stone-500">
          requested <RelTime iso={approval.requested_at} />
        </span>
        {approval.required_approvals > 1 && (
          <span className="text-xs font-medium text-waiting">
            {approval.approved_count} of {approval.required_approvals} approvals
          </span>
        )}
        <Link
          to="/runs/$runId"
          params={{ runId: approval.run_id }}
          className="ml-auto text-xs font-medium text-ink underline underline-offset-2"
        >
          View run
        </Link>
      </div>
      <div className="mt-3">
        <ApprovalDecision
          approvalId={approval.id}
          stepKey={approval.step_key}
          onDecided={() =>
            void navigate({ to: "/runs/$runId", params: { runId: approval.run_id } })
          }
        />
      </div>
    </div>
  );
}
