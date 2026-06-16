-- Outbound webhook endpoints. Deliveries are fire-and-forget notifications
-- signed with a per-endpoint HMAC secret; the audit chain remains the
-- canonical record (webhooks are a convenience, never a source of truth).

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  secret text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
