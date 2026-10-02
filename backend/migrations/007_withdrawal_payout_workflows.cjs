exports.up = (pgm) => pgm.sql(`
  CREATE FUNCTION enforce_kyc_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.status = OLD.status THEN RETURN NEW; END IF;
    IF (OLD.status = 'unverified' AND NEW.status = 'pending')
       OR (OLD.status = 'pending' AND NEW.status IN ('verified', 'rejected'))
       OR (OLD.status = 'verified' AND NEW.status = 'suspended')
       OR (OLD.status = 'rejected' AND NEW.status = 'pending')
       OR (OLD.status = 'suspended' AND NEW.status IN ('verified', 'pending')) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid KYC status transition'
      USING ERRCODE = '23514', CONSTRAINT = 'kyc_status_transition';
  END;
  $$;
  CREATE TRIGGER kyc_profiles_status_transition
    BEFORE UPDATE OF status ON kyc_profiles
    FOR EACH ROW EXECUTE FUNCTION enforce_kyc_status_transition();

  CREATE FUNCTION reject_kyc_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'KYC audit records are append-only' USING ERRCODE = '55000';
    RETURN NULL;
  END;
  $$;
  CREATE TRIGGER kyc_audit_events_append_only
    BEFORE UPDATE OR DELETE ON kyc_audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_kyc_audit_mutation();

  ALTER TABLE withdrawal_requests
    ADD CONSTRAINT withdrawal_requests_id_user_unique UNIQUE (id, user_id);
  ALTER TABLE wallet_transactions
    ADD CONSTRAINT wallet_transactions_id_user_unique UNIQUE (id, user_id);

  CREATE TABLE withdrawal_workflows (
    withdrawal_request_id UUID PRIMARY KEY REFERENCES withdrawal_requests(id),
    user_id UUID NOT NULL REFERENCES users(id),
    current_transaction_id UUID NOT NULL REFERENCES wallet_transactions(id),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled')),
    reviewed_by_user_id UUID REFERENCES users(id),
    review_reason VARCHAR(240),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT withdrawal_workflow_current_tx_unique UNIQUE (current_transaction_id),
    CONSTRAINT withdrawal_workflow_owner_fk FOREIGN KEY (withdrawal_request_id, user_id)
      REFERENCES withdrawal_requests (id, user_id),
    CONSTRAINT withdrawal_workflow_current_tx_owner_fk FOREIGN KEY (current_transaction_id, user_id)
      REFERENCES wallet_transactions (id, user_id)
  );
  CREATE INDEX withdrawal_workflows_status_created_idx ON withdrawal_workflows (status, created_at DESC);

  INSERT INTO withdrawal_workflows (withdrawal_request_id, user_id, current_transaction_id, status, created_at, updated_at)
  SELECT r.id, r.user_id, r.transaction_id,
    CASE latest.to_status
      WHEN 'approved' THEN 'approved'
      WHEN 'completed' THEN 'paid'
      WHEN 'failed' THEN 'failed'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE 'pending'
    END,
    r.created_at, r.updated_at
  FROM withdrawal_requests r
  LEFT JOIN LATERAL (
    SELECT e.to_status FROM wallet_transaction_events e
    WHERE e.transaction_id=r.transaction_id
    ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
  ) latest ON true;
  CREATE FUNCTION enforce_withdrawal_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.status = OLD.status THEN RETURN NEW; END IF;
    IF (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
       OR (OLD.status = 'approved' AND NEW.status IN ('processing', 'rejected', 'cancelled'))
       OR (OLD.status = 'processing' AND NEW.status IN ('paid', 'failed'))
       OR (OLD.status = 'failed' AND NEW.status = 'processing') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid withdrawal status transition'
      USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_status_transition';
  END;
  $$;
  CREATE TRIGGER withdrawal_workflows_status_transition
    BEFORE UPDATE OF status ON withdrawal_workflows
    FOR EACH ROW EXECUTE FUNCTION enforce_withdrawal_status_transition();

  CREATE TABLE withdrawal_workflow_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    withdrawal_request_id UUID NOT NULL REFERENCES withdrawal_requests(id),
    actor_user_id UUID REFERENCES users(id),
    from_status TEXT CHECK (from_status IS NULL OR from_status IN ('pending', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled')),
    to_status TEXT NOT NULL CHECK (to_status IN ('pending', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled')),
    action TEXT NOT NULL CHECK (action IN ('requested', 'approved', 'rejected', 'processing', 'paid', 'failed', 'cancelled', 'retried', 'reconciled', 'provider_event')),
    reason VARCHAR(240),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO withdrawal_workflow_events (withdrawal_request_id, actor_user_id, from_status, to_status, action, created_at)
  SELECT w.withdrawal_request_id, NULL, NULL, w.status, 'requested', w.created_at
  FROM withdrawal_workflows w;
  CREATE INDEX withdrawal_workflow_events_history_idx
    ON withdrawal_workflow_events (withdrawal_request_id, created_at DESC, id DESC);

  CREATE TABLE payout_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    withdrawal_request_id UUID NOT NULL REFERENCES withdrawal_requests(id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    provider VARCHAR(32) NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
    idempotency_key VARCHAR(160) NOT NULL UNIQUE,
    provider_reference_id VARCHAR(128),
    status TEXT NOT NULL CHECK (status IN ('processing', 'unknown', 'paid', 'failed')),
    last_reconciled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payout_attempt_number_unique UNIQUE (withdrawal_request_id, attempt_number)
  );
  CREATE UNIQUE INDEX payout_attempt_provider_reference_unique
    ON payout_attempts (provider, provider_reference_id) WHERE provider_reference_id IS NOT NULL;
  CREATE INDEX payout_attempts_status_idx ON payout_attempts (status, updated_at DESC);

  CREATE TABLE payout_provider_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(32) NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
    provider_event_id VARCHAR(128) NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 128),
    payout_attempt_id UUID REFERENCES payout_attempts(id),
    event_type VARCHAR(128) NOT NULL,
    provider_reference_id VARCHAR(128),
    provider_status VARCHAR(64),
    amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
    currency CHAR(3),
    payload_sha256 BYTEA NOT NULL CHECK (octet_length(payload_sha256) = 32),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payout_provider_event_unique UNIQUE (provider, provider_event_id)
  );
  CREATE INDEX payout_provider_events_attempt_idx
    ON payout_provider_events (payout_attempt_id, received_at DESC)
    WHERE payout_attempt_id IS NOT NULL;

  CREATE FUNCTION reject_withdrawal_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'withdrawal and payout events are append-only' USING ERRCODE = '55000';
    RETURN NULL;
  END;
  $$;
  CREATE TRIGGER withdrawal_workflow_events_append_only
    BEFORE UPDATE OR DELETE ON withdrawal_workflow_events
    FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_event_mutation();
  CREATE TRIGGER payout_provider_events_append_only
    BEFORE UPDATE OR DELETE ON payout_provider_events
    FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_event_mutation();
`);

exports.down = () => {
  throw new Error('Migration 007 is forward-only: payout and withdrawal audit records cannot be safely discarded.');
};
