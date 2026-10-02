exports.up = (pgm) => pgm.sql(`
  CREATE TABLE kyc_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'unverified'
      CHECK (status IN ('unverified', 'pending', 'verified', 'rejected', 'suspended')),
    legal_name VARCHAR(120),
    country VARCHAR(80),
    date_of_birth DATE,
    verification_reference VARCHAR(128),
    rejection_reason VARCHAR(240),
    reviewed_by_user_id UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX kyc_profiles_status_idx ON kyc_profiles (status, updated_at DESC);

  CREATE TABLE kyc_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_user_id UUID NOT NULL REFERENCES users(id),
    from_status TEXT NOT NULL
      CHECK (from_status IN ('unverified', 'pending', 'verified', 'rejected', 'suspended')),
    to_status TEXT NOT NULL
      CHECK (to_status IN ('unverified', 'pending', 'verified', 'rejected', 'suspended')),
    action TEXT NOT NULL CHECK (action IN ('submitted', 'reviewed', 'rejected', 'suspended', 'reinstated')),
    reason VARCHAR(240),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata) <= 4096),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX kyc_audit_events_user_idx ON kyc_audit_events (user_id, created_at DESC);
`);

exports.down = (pgm) => pgm.sql(`
  DROP TABLE IF EXISTS kyc_audit_events;
  DROP TABLE IF EXISTS kyc_profiles;
`);
