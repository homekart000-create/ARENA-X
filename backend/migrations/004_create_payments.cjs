exports.up = (pgm) => pgm.sql(`
  CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    provider VARCHAR(32) NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
    provider_order_id VARCHAR(128),
    provider_payment_id VARCHAR(128),
    provider_reference_id VARCHAR(128),
    wallet_id UUID,
    wallet_transaction_id UUID,
    amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000),
    currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    status TEXT NOT NULL DEFAULT 'created'
      CHECK (status IN ('created', 'pending', 'paid', 'failed', 'cancelled', 'refunded')),
    idempotency_key VARCHAR(128) NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    failure_code VARCHAR(80),
    reconciliation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      CHECK (pg_column_size(reconciliation_metadata) <= 4096),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT payments_user_idempotency_unique UNIQUE (user_id, idempotency_key),
    CONSTRAINT payments_wallet_mapping_shape CHECK (
      (wallet_id IS NULL AND wallet_transaction_id IS NULL)
      OR (wallet_id IS NOT NULL AND wallet_transaction_id IS NOT NULL)
    ),
    CONSTRAINT payments_wallet_transaction_unique UNIQUE (wallet_transaction_id),
    CONSTRAINT payments_wallet_transaction_owner_fk
      FOREIGN KEY (wallet_transaction_id, wallet_id, user_id, currency)
      REFERENCES wallet_transactions (id, wallet_id, user_id, currency)
  );
  CREATE UNIQUE INDEX payments_provider_order_unique
    ON payments (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
  CREATE UNIQUE INDEX payments_provider_payment_unique
    ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
  CREATE UNIQUE INDEX payments_provider_reference_unique
    ON payments (provider, provider_reference_id) WHERE provider_reference_id IS NOT NULL;
  CREATE INDEX payments_user_history_idx ON payments (user_id, created_at DESC, id DESC);
  CREATE INDEX payments_status_updated_idx ON payments (status, updated_at DESC);

  CREATE FUNCTION enforce_payment_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.status = OLD.status THEN
      RETURN NEW;
    END IF;
    IF (OLD.status = 'created' AND NEW.status IN ('pending', 'failed', 'cancelled'))
       OR (OLD.status = 'pending' AND NEW.status IN ('paid', 'failed', 'cancelled'))
       OR (OLD.status = 'paid' AND NEW.status = 'refunded') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid payment status transition'
      USING ERRCODE = '23514', CONSTRAINT = 'payments_status_transition';
  END;
  $$;
  CREATE TRIGGER payments_status_transition
    BEFORE UPDATE OF status ON payments
    FOR EACH ROW EXECUTE FUNCTION enforce_payment_status_transition();

  CREATE TABLE payment_provider_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(32) NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
    provider_event_id VARCHAR(128) NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 128),
    payment_id UUID REFERENCES payments(id),
    provider_order_id VARCHAR(128),
    provider_payment_id VARCHAR(128),
    event_type VARCHAR(128) NOT NULL,
    provider_status VARCHAR(64),
    amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
    currency CHAR(3),
    payload_sha256 BYTEA NOT NULL CHECK (octet_length(payload_sha256) = 32),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payment_provider_event_unique UNIQUE (provider, provider_event_id)
  );
  CREATE INDEX payment_provider_events_payment_idx
    ON payment_provider_events (payment_id, received_at DESC) WHERE payment_id IS NOT NULL;
`);

exports.down = (pgm) => pgm.sql(`
  DROP TABLE IF EXISTS payment_provider_events;
  DROP TABLE IF EXISTS payments;
  DROP FUNCTION IF EXISTS enforce_payment_status_transition();
`);
