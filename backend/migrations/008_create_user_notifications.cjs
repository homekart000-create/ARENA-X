exports.up = (pgm) => pgm.sql(`
  CREATE TABLE user_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_key TEXT NOT NULL,
    type VARCHAR(40) NOT NULL,
    title VARCHAR(120) NOT NULL,
    message VARCHAR(500) NOT NULL,
    related_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at TIMESTAMPTZ,
    UNIQUE (user_id, notification_key)
  );
  CREATE INDEX user_notifications_user_created_idx
    ON user_notifications (user_id, created_at DESC);
`);

exports.down = (pgm) => pgm.sql(`
  DROP TABLE IF EXISTS user_notifications;
`);
