exports.up = (pgm) => pgm.sql(`
  CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restricted', 'closed')),
    available_balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (available_balance_minor BETWEEN 0 AND 9007199254740991),
    reserved_balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (reserved_balance_minor BETWEEN 0 AND 9007199254740991),
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, user_id, currency)
  );
  CREATE INDEX wallets_status_created_idx ON wallets (status, created_at DESC);

  CREATE TABLE ledger_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
    tournament_id UUID REFERENCES tournaments(id),
    account_type TEXT NOT NULL CHECK (account_type IN ('user_available', 'user_reserved', 'platform_clearing', 'tournament_prize_pool', 'fee_revenue')),
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_account_owner_shape CHECK (
      (account_type IN ('user_available', 'user_reserved') AND wallet_id IS NOT NULL)
      OR (account_type IN ('platform_clearing', 'fee_revenue') AND wallet_id IS NULL AND tournament_id IS NULL)
      OR (account_type = 'tournament_prize_pool' AND wallet_id IS NULL AND tournament_id IS NOT NULL)
    ),
    UNIQUE (id, currency)
  );
  CREATE UNIQUE INDEX ledger_wallet_account_unique
    ON ledger_accounts (wallet_id, account_type, currency) WHERE wallet_id IS NOT NULL;
  CREATE UNIQUE INDEX ledger_system_account_unique
    ON ledger_accounts (account_type, currency) WHERE wallet_id IS NULL AND tournament_id IS NULL;
  CREATE UNIQUE INDEX ledger_tournament_pool_unique
    ON ledger_accounts (tournament_id, currency) WHERE account_type = 'tournament_prize_pool';
  CREATE INDEX ledger_accounts_type_currency_idx ON ledger_accounts (account_type, currency);

  INSERT INTO ledger_accounts (account_type, currency) VALUES ('platform_clearing', 'INR');
  INSERT INTO ledger_accounts (account_type, currency) VALUES ('fee_revenue', 'INR');

  CREATE FUNCTION create_wallet_ledger_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO ledger_accounts (wallet_id, account_type, currency)
    VALUES (NEW.id, 'user_available', NEW.currency), (NEW.id, 'user_reserved', NEW.currency);
    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER wallets_create_ledger_accounts
    AFTER INSERT ON wallets FOR EACH ROW EXECUTE FUNCTION create_wallet_ledger_accounts();

  CREATE FUNCTION create_wallet_for_user() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO wallets (user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER users_create_wallet
    AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION create_wallet_for_user();

  INSERT INTO wallets (user_id)
    SELECT id FROM users ON CONFLICT (user_id) DO NOTHING;

  CREATE TABLE wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    user_id UUID NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'entry_fee', 'winning', 'refund', 'adjustment')),
    direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
    amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000),
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    idempotency_key VARCHAR(128) NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    reference_id VARCHAR(120),
    related_transaction_id UUID REFERENCES wallet_transactions(id),
    actor_user_id UUID REFERENCES users(id),
    description VARCHAR(160) NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata) <= 4096),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT wallet_transaction_direction_check CHECK (
      (type IN ('deposit', 'winning', 'refund') AND direction = 'credit')
      OR (type IN ('withdrawal', 'entry_fee') AND direction = 'debit')
      OR type = 'adjustment'
    ),
    CONSTRAINT wallet_transaction_idempotency_unique UNIQUE (user_id, idempotency_key),
    CONSTRAINT wallet_transaction_id_currency_unique UNIQUE (id, currency),
    CONSTRAINT wallet_transaction_owner_currency_fk FOREIGN KEY (wallet_id, user_id, currency)
      REFERENCES wallets (id, user_id, currency),
    CONSTRAINT wallet_transaction_owner_tuple_unique UNIQUE (id, wallet_id, user_id, currency)
  );
  CREATE UNIQUE INDEX wallet_transaction_reference_unique
    ON wallet_transactions (reference_id) WHERE reference_id IS NOT NULL;
  CREATE INDEX wallet_transactions_history_idx ON wallet_transactions (wallet_id, created_at DESC, id DESC);
  CREATE INDEX wallet_transactions_type_history_idx ON wallet_transactions (wallet_id, type, created_at DESC, id DESC);
  CREATE INDEX wallet_transactions_related_idx ON wallet_transactions (related_transaction_id) WHERE related_transaction_id IS NOT NULL;

  CREATE TABLE wallet_transaction_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES wallet_transactions(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'completed', 'pending', 'failed', 'reversed', 'approved', 'rejected', 'cancelled')),
    from_status TEXT CHECK (from_status IS NULL OR from_status IN ('pending', 'completed', 'failed', 'reversed', 'approved', 'rejected', 'cancelled')),
    to_status TEXT NOT NULL CHECK (to_status IN ('pending', 'completed', 'failed', 'reversed', 'approved', 'rejected', 'cancelled')),
    actor_user_id UUID REFERENCES users(id),
    reason VARCHAR(240),
    request_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata) <= 4096),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX wallet_transaction_events_history_idx ON wallet_transaction_events (transaction_id, occurred_at DESC, id DESC);
  CREATE INDEX wallet_transaction_events_type_idx ON wallet_transaction_events (event_type, occurred_at DESC);

  CREATE TABLE wallet_ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES wallet_transactions(id),
    account_id UUID NOT NULL REFERENCES ledger_accounts(id),
    amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    entry_kind TEXT NOT NULL CHECK (entry_kind IN ('credit', 'debit', 'hold', 'release', 'settlement', 'reversal')),
    reverses_entry_id UUID REFERENCES wallet_ledger_entries(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (transaction_id, account_id, entry_kind),
    FOREIGN KEY (transaction_id, currency) REFERENCES wallet_transactions (id, currency),
    FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts (id, currency)
  );
  CREATE INDEX wallet_ledger_entries_account_idx ON wallet_ledger_entries (account_id, created_at);
  CREATE INDEX wallet_ledger_entries_transaction_idx ON wallet_ledger_entries (transaction_id);

  CREATE FUNCTION enforce_balanced_wallet_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    ledger_total NUMERIC;
  BEGIN
    SELECT COALESCE(sum(amount_minor), 0) INTO ledger_total
    FROM wallet_ledger_entries WHERE transaction_id = NEW.transaction_id;
    IF ledger_total <> 0 THEN
      RAISE EXCEPTION 'wallet transaction ledger entries must balance' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END;
  $$;

  CREATE CONSTRAINT TRIGGER wallet_transaction_entries_balanced
    AFTER INSERT ON wallet_ledger_entries DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_balanced_wallet_transaction();

  CREATE FUNCTION reject_wallet_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'wallet ledger records are append-only' USING ERRCODE = '55000';
    RETURN NULL;
  END;
  $$;

  CREATE TRIGGER wallet_transactions_append_only
    BEFORE UPDATE OR DELETE ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();
  CREATE TRIGGER wallet_ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();
  CREATE TRIGGER wallet_transaction_events_append_only
    BEFORE UPDATE OR DELETE ON wallet_transaction_events FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();

  CREATE TABLE withdrawal_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL UNIQUE REFERENCES wallet_transactions(id),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    user_id UUID NOT NULL REFERENCES users(id),
    amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000),
    currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (wallet_id, user_id, currency) REFERENCES wallets (id, user_id, currency),
    FOREIGN KEY (transaction_id, wallet_id, user_id, currency)
      REFERENCES wallet_transactions (id, wallet_id, user_id, currency)
  );
  CREATE INDEX withdrawal_requests_user_history_idx ON withdrawal_requests (user_id, created_at DESC);
  CREATE INDEX withdrawal_requests_wallet_idx ON withdrawal_requests (wallet_id, created_at DESC);

  CREATE TRIGGER withdrawal_requests_append_only
    BEFORE UPDATE OR DELETE ON withdrawal_requests FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();
`);

exports.down = (pgm) => pgm.sql(`
  DROP TRIGGER IF EXISTS withdrawal_requests_append_only ON withdrawal_requests;
  DROP TABLE IF EXISTS withdrawal_requests;
  DROP TRIGGER IF EXISTS wallet_transaction_events_append_only ON wallet_transaction_events;
  DROP TRIGGER IF EXISTS wallet_ledger_entries_append_only ON wallet_ledger_entries;
  DROP TRIGGER IF EXISTS wallet_transactions_append_only ON wallet_transactions;
  DROP TRIGGER IF EXISTS wallet_transaction_entries_balanced ON wallet_ledger_entries;
  DROP TRIGGER IF EXISTS users_create_wallet ON users;
  DROP TRIGGER IF EXISTS wallets_create_ledger_accounts ON wallets;
  DROP FUNCTION IF EXISTS reject_wallet_ledger_mutation();
  DROP FUNCTION IF EXISTS enforce_balanced_wallet_transaction();
  DROP FUNCTION IF EXISTS create_wallet_for_user();
  DROP FUNCTION IF EXISTS create_wallet_ledger_accounts();
  DROP TABLE IF EXISTS wallet_ledger_entries;
  DROP TABLE IF EXISTS wallet_transaction_events;
  DROP TABLE IF EXISTS wallet_transactions;
  DROP TABLE IF EXISTS ledger_accounts;
  DROP TABLE IF EXISTS wallets;
`);