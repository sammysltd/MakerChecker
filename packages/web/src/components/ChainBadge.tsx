import type { VerifyResult } from "../lib/api";
import { truncateHash } from "../lib/format";

/**
 * Hash-chain integrity indicator from GET /audit/verify. The happy state is
 * quiet green; a failed verification is a full-force TAMPER DETECTED block.
 */
export function ChainBadge({ verify }: { verify: VerifyResult | undefined }) {
  if (!verify) {
    return (
      <div className="rounded border border-line bg-white px-3 py-2 text-xs text-stone-500">
        Verifying audit chain…
      </div>
    );
  }
  if (!verify.ok) {
    return (
      <div className="border-l-4 border-blocked bg-red-50 px-4 py-3" role="alert">
        <p className="text-sm font-bold uppercase tracking-[0.1em] text-blocked">
          Tamper detected
        </p>
        <p className="mt-1 text-xs leading-relaxed text-blocked">
          Chain verification failed at seq {verify.failedSeq}: {verify.reason}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-green-200 bg-green-50 px-3 py-2">
      <span className="text-xs font-medium text-verified">
        Chain verified ✓ ({verify.count.toLocaleString("en-US")} events)
      </span>
      <span className="font-mono text-[10px] text-stone-500" title={verify.headHash ?? ""}>
        {truncateHash(verify.headHash)}
      </span>
    </div>
  );
}
