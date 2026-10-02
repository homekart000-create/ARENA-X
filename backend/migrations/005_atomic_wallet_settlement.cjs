exports.up = (pgm) => pgm.sql(`
  ALTER TABLE payments DROP CONSTRAINT payments_status_check;
  ALTER TABLE payments ADD CONSTRAINT payments_status_check
    CHECK (status IN ('created', 'pending', 'paid', 'settled', 'failed', 'cancelled', 'refunded'));
  ALTER TABLE payments ADD CONSTRAINT payments_settlement_mapping_check
    CHECK (
      (status IN ('settled', 'refunded') AND wallet_id IS NOT NULL AND wallet_transaction_id IS NOT NULL)
      OR (status NOT IN ('settled', 'refunded') AND wallet_id IS NULL AND wallet_transaction_id IS NULL)
    );

  CREATE OR REPLACE FUNCTION enforce_payment_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.status = OLD.status THEN
      RETURN NEW;
    END IF;
    IF (OLD.status = 'created' AND NEW.status IN ('pending', 'failed', 'cancelled'))
       OR (OLD.status = 'pending' AND NEW.status IN ('paid', 'failed', 'cancelled'))
       OR (OLD.status = 'paid' AND NEW.status = 'settled')
       OR (OLD.status = 'settled' AND NEW.status = 'refunded') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid payment status transition'
      USING ERRCODE = '23514', CONSTRAINT = 'payments_status_transition';
  END;
  $$;

  ALTER TABLE tournament_registrations
    ADD COLUMN entry_fee_payer_user_id UUID,
    ADD COLUMN entry_fee_wallet_id UUID,
    ADD COLUMN entry_fee_transaction_id UUID,
    ADD COLUMN entry_fee_refund_transaction_id UUID;

  ALTER TABLE tournament_registrations
    ADD CONSTRAINT tournament_registration_entry_fee_transaction_unique UNIQUE (entry_fee_transaction_id),
    ADD CONSTRAINT tournament_registration_refund_transaction_unique UNIQUE (entry_fee_refund_transaction_id),
    ADD CONSTRAINT tournament_registration_entry_fee_wallet_fk
      FOREIGN KEY (entry_fee_transaction_id, entry_fee_wallet_id, entry_fee_payer_user_id, currency)
      REFERENCES wallet_transactions (id, wallet_id, user_id, currency),
    ADD CONSTRAINT tournament_registration_refund_wallet_fk
      FOREIGN KEY (entry_fee_refund_transaction_id, entry_fee_wallet_id, entry_fee_payer_user_id, currency)
      REFERENCES wallet_transactions (id, wallet_id, user_id, currency),
    ADD CONSTRAINT tournament_registration_entry_fee_mapping_check CHECK (
      (entry_fee_minor = 0 AND entry_fee_payer_user_id IS NULL AND entry_fee_wallet_id IS NULL
        AND entry_fee_transaction_id IS NULL AND entry_fee_refund_transaction_id IS NULL)
      OR (entry_fee_minor > 0 AND entry_fee_payer_user_id IS NOT NULL AND entry_fee_wallet_id IS NOT NULL
        AND entry_fee_transaction_id IS NOT NULL)
    ),
    ADD CONSTRAINT tournament_registration_entry_fee_amount_check
      CHECK (entry_fee_minor BETWEEN 0 AND 100000000),
    ADD CONSTRAINT tournament_registration_refund_requires_paid_entry_check CHECK (
      entry_fee_refund_transaction_id IS NULL OR entry_fee_minor > 0
    ),
    ADD CONSTRAINT tournament_registration_cancelled_paid_refund_check CHECK (
      status <> 'cancelled' OR entry_fee_minor = 0 OR entry_fee_refund_transaction_id IS NOT NULL
    );
`);

exports.down = () => {
  throw new Error('Migration 005 is forward-only: wallet settlement records cannot be safely discarded.');
};
