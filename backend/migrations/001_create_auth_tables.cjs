exports.up = (pgm) => pgm.sql(`
  CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(20) NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    email_normalized TEXT NOT NULL,
    phone VARCHAR(20),
    date_of_birth DATE,
    avatar VARCHAR(8),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_username_format CHECK (username ~ '^[A-Za-z0-9_]{3,20}$'),
    CONSTRAINT users_full_name_length CHECK (char_length(full_name) BETWEEN 2 AND 120)
  );

  CREATE UNIQUE INDEX users_username_lower_unique ON users (lower(username));
  CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email_normalized));

  CREATE TABLE user_credentials (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    hash_algorithm TEXT NOT NULL DEFAULT 'argon2id' CHECK (hash_algorithm = 'argon2id'),
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    password_reset_required BOOLEAN NOT NULL DEFAULT false,
    failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE user_role_assignments (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, role)
  );
  CREATE INDEX user_role_assignments_active_role_idx
    ON user_role_assignments (role, user_id) WHERE revoked_at IS NULL;

  CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  );
  CREATE INDEX auth_sessions_user_expiry_idx ON auth_sessions (user_id, expires_at);
  CREATE INDEX auth_sessions_active_expiry_idx ON auth_sessions (expires_at) WHERE revoked_at IS NULL;
`);

exports.down = (pgm) => pgm.sql(`
  DROP TABLE IF EXISTS auth_sessions;
  DROP TABLE IF EXISTS user_role_assignments;
  DROP TABLE IF EXISTS user_credentials;
  DROP TABLE IF EXISTS users;
`);