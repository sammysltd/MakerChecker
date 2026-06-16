import {
  isApprovalGate,
  type AgentStepDef,
  type ApprovalGateStepDef,
  type FlowDefinition,
  type RunApproval,
  type StepRun,
} from "../lib/api";
import { formatDuration, statusKind } from "../lib/format";
import { ApprovalDecision } from "./ApprovalDecision";
import { JsonBlock } from "./JsonBlock";
import { OutputView } from "./OutputView";
import { RelTime, SkillChip, StatusPill } from "./ui";

/**
 * The vertical step timeline: the flow definition is the spine, run state is
 * draped over it. Renders statically (flow visualizer) when no run data is
 * passed. This is the hero of the run viewer.
 */
export function RunTimeline({
  definition,
  steps = [],
  approvals = [],
}: {
  definition: FlowDefinition;
  steps?: StepRun[];
  approvals?: RunApproval[];
}) {
  return (
    <ol className="relative ml-2 border-l border-line pl-6">
      {definition.steps.map((step) =>
        isApprovalGate(step) ? (
          <GateStep
            key={step.key}
            step={step}
            approval={approvals.find((a) => a.step_key === step.key)}
          />
        ) : (
          <AgentStep
            key={step.key}
            step={step}
            attempts={steps.filter((s) => s.step_key === step.key)}
          />
        ),
      )}
    </ol>
  );
}

const MARKER: Record<string, string> = {
  good: "border-verified bg-verified",
  waiting: "border-waiting bg-waiting",
  bad: "border-blocked bg-blocked",
  neutral: "border-stone-300 bg-white",
};

function Marker({ status }: { status: string | null }) {
  const kind = status ? statusKind(status) : "neutral";
  return (
    <span
      aria-hidden="true"
      className={`absolute -left-[31px] top-1.5 h-2.5 w-2.5 rounded-full border-2 ${MARKER[kind]}`}
    />
  );
}

function AgentStep({ step, attempts }: { step: AgentStepDef; attempts: StepRun[] }) {
  const latest = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
  return (
    <li className="relative pb-8 last:pb-0">
      <Marker status={latest?.status ?? null} />
      <div className="rounded border border-line bg-white px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[11px] text-stone-400">{step.key}</span>
          <span className="text-sm font-medium text-ink">{step.agent}</span>
          {latest ? (
            <StatusPill status={latest.status} />
          ) : (
            <StatusPill status="not started" />
          )}
          {attempts.length > 1 && (
            <span className="text-[11px] text-waiting">attempt ×{attempts.length}</span>
          )}
          {latest?.started_at && (
            <span className="ml-auto font-mono text-[11px] text-stone-500">
              {formatDuration(latest.started_at, latest.finished_at)}
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {step.skills.map((ref) => (
            <SkillChip key={ref} skillRef={ref} />
          ))}
        </div>
        {step.instructions && (
          <p className="mt-2 text-xs leading-relaxed text-stone-500">{step.instructions}</p>
        )}
        {latest && (
          <div className="mt-3 space-y-2 border-t border-line pt-3">
            <JsonBlock label="Input" value={latest.input} />
            <OutputView output={latest.output} />
            {latest.error != null && (
              <JsonBlock label="Error" value={latest.error} tone="error" defaultOpen />
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function GateStep({
  step,
  approval,
}: {
  step: ApprovalGateStepDef;
  approval: RunApproval | undefined;
}) {
  const decided = approval && approval.status !== "pending";
  const multi = approval !== undefined && approval.required_approvals > 1;
  const pending = approval?.status === "pending";
  return (
    <li className="relative pb-8 last:pb-0">
      <Marker status={approval ? approval.status : null} />
      <div className="rounded border border-line bg-stone-50 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-400">
            Approval gate
          </span>
          <span className="text-sm font-medium text-ink">{step.title}</span>
          {approval ? (
            <StatusPill status={approval.status} />
          ) : (
            <StatusPill status="not reached" />
          )}
        </div>
        {approval && approval.status === "pending" && (
          <p className="mt-2 text-xs text-waiting">
            Awaiting human decision — requested <RelTime iso={approval.requested_at} />
          </p>
        )}
        {multi && <GateDecisions approval={approval} />}
        {decided && !multi && (
          <div className="mt-2">
            <p className="text-xs text-stone-600">
              <span className="font-medium text-ink">{approval.status}</span> by{" "}
              <span className="font-medium text-ink">{approval.decided_by ?? "unknown"}</span>{" "}
              <RelTime iso={approval.decided_at} />
            </p>
            {approval.reason && (
              <blockquote
                className={`mt-2 border-l-4 px-3 py-2 text-sm italic leading-relaxed text-ink ${
                  approval.status === "rejected"
                    ? "border-blocked bg-red-50"
                    : "border-verified bg-green-50"
                }`}
              >
                “{approval.reason}”
              </blockquote>
            )}
          </div>
        )}
        {pending && approval && (
          <div className="mt-3 border-t border-line pt-3">
            <p className="mb-2 text-xs leading-relaxed text-stone-600">
              One accountable sign-off: <span className="font-medium text-ink">approve</span> to
              authorise the agent&apos;s recommended actions above, or{" "}
              <span className="font-medium text-ink">reject</span> to halt the run. It is a single
              decision over the whole step — recorded, with your reason, in the audit log.
            </p>
            <ApprovalDecision approvalId={approval.id} stepKey={step.key} />
          </div>
        )}
      </div>
    </li>
  );
}

/** n-of-m gates: "Approvals: 1 of 2" plus one line per recorded decision. */
function GateDecisions({ approval }: { approval: RunApproval }) {
  const approvedCount = approval.decisions.filter((d) => d.decision === "approved").length;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-ink">
        Approvals: {approvedCount} of {approval.required_approvals}
      </p>
      {approval.decisions.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {approval.decisions.map((d) => (
            <li key={d.id} className="text-xs text-stone-600">
              <span className="font-medium text-ink">{d.decided_by ?? "unknown"}</span>{" "}
              <span className={d.decision === "rejected" ? "text-blocked" : "text-verified"}>
                {d.decision}
              </span>
              {d.reason && <span className="italic"> — “{d.reason}”</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
