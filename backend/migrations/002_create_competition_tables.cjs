exports.up = (pgm) => pgm.sql(`
  CREATE TABLE tournaments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id),
    name VARCHAR(120) NOT NULL,
    game VARCHAR(60) NOT NULL,
    participation_type TEXT NOT NULL CHECK (participation_type IN ('Solo', 'Duo', 'Squad')),
    mode VARCHAR(100) NOT NULL,
    entry_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (entry_fee_minor >= 0),
    prize_pool_minor BIGINT NOT NULL DEFAULT 0 CHECK (prize_pool_minor >= 0),
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    max_slots INTEGER NOT NULL CHECK (max_slots > 0),
    starts_at TIMESTAMPTZ NOT NULL,
    registration_deadline TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('draft', 'upcoming', 'live', 'completed', 'cancelled')),
    banner_key VARCHAR(80),
    description TEXT NOT NULL DEFAULT '',
    map VARCHAR(80) NOT NULL DEFAULT '',
    host_name VARCHAR(120) NOT NULL DEFAULT '',
    featured BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tournaments_registration_before_start CHECK (registration_deadline <= starts_at)
  );
  CREATE INDEX tournaments_public_schedule_idx ON tournaments (status, starts_at) WHERE status <> 'draft';
  CREATE INDEX tournaments_game_status_idx ON tournaments (game, status, starts_at);

  CREATE TABLE tournament_rules (
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    position SMALLINT NOT NULL CHECK (position >= 0),
    rule_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tournament_id, position)
  );

  CREATE TABLE tournament_prize_distributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    position SMALLINT NOT NULL CHECK (position >= 0),
    place_label VARCHAR(60) NOT NULL,
    share_basis_points INTEGER NOT NULL CHECK (share_basis_points BETWEEN 0 AND 10000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tournament_id, position)
  );

  CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id),
    team_name VARCHAR(32) NOT NULL,
    team_tag VARCHAR(6) NOT NULL,
    logo_key VARCHAR(80) NOT NULL DEFAULT '',
    description VARCHAR(240) NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT teams_name_length CHECK (char_length(team_name) BETWEEN 3 AND 32),
    CONSTRAINT teams_tag_format CHECK (team_tag ~ '^[A-Z0-9]{2,6}$')
  );
  CREATE UNIQUE INDEX teams_name_lower_unique ON teams (lower(team_name));
  CREATE UNIQUE INDEX teams_tag_lower_unique ON teams (lower(team_tag));
  CREATE INDEX teams_status_created_idx ON teams (status, created_at DESC);

  CREATE TABLE team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('captain', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX team_members_active_pair_unique ON team_members (team_id, user_id) WHERE left_at IS NULL;
  CREATE UNIQUE INDEX team_members_active_user_unique ON team_members (user_id) WHERE left_at IS NULL;
  CREATE UNIQUE INDEX team_members_active_captain_unique ON team_members (team_id) WHERE role = 'captain' AND left_at IS NULL;
  CREATE INDEX team_members_user_active_idx ON team_members (user_id, team_id) WHERE left_at IS NULL;

  CREATE TABLE team_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    sender_user_id UUID NOT NULL REFERENCES users(id),
    receiver_user_id UUID NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX team_invitations_pending_unique ON team_invitations (team_id, receiver_user_id) WHERE status = 'pending';
  CREATE INDEX team_invitations_receiver_status_idx ON team_invitations (receiver_user_id, status, created_at DESC);

  CREATE TABLE tournament_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id),
    captain_user_id UUID NOT NULL REFERENCES users(id),
    team_id UUID REFERENCES teams(id),
    status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'cancelled', 'disqualified')),
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at TIMESTAMPTZ,
    entry_fee_minor BIGINT NOT NULL CHECK (entry_fee_minor >= 0),
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, tournament_id)
  );
  CREATE UNIQUE INDEX tournament_registrations_active_team_unique
    ON tournament_registrations (tournament_id, team_id) WHERE team_id IS NOT NULL AND status = 'registered';
  CREATE UNIQUE INDEX tournament_registrations_active_solo_unique
    ON tournament_registrations (tournament_id, captain_user_id) WHERE team_id IS NULL AND status = 'registered';
  CREATE INDEX tournament_registrations_tournament_status_idx ON tournament_registrations (tournament_id, status, registered_at);

  CREATE TABLE registration_members (
    registration_id UUID NOT NULL,
    tournament_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('captain', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (registration_id, user_id),
    FOREIGN KEY (registration_id, tournament_id) REFERENCES tournament_registrations(id, tournament_id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX registration_members_active_player_unique ON registration_members (tournament_id, user_id) WHERE left_at IS NULL;
  CREATE INDEX registration_members_user_active_idx ON registration_members (user_id, tournament_id) WHERE left_at IS NULL;

  CREATE TABLE matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id),
    match_number INTEGER NOT NULL CHECK (match_number > 0),
    title VARCHAR(80) NOT NULL,
    game VARCHAR(60) NOT NULL,
    mode VARCHAR(80) NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'live', 'completed', 'cancelled')),
    result_status TEXT NOT NULL DEFAULT 'pending' CHECK (result_status IN ('pending', 'submitted', 'published', 'rejected')),
    max_participants INTEGER NOT NULL CHECK (max_participants > 0),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
    map VARCHAR(80) NOT NULL DEFAULT '',
    instructions VARCHAR(1000) NOT NULL DEFAULT '',
    home_featured BOOLEAN NOT NULL DEFAULT false,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tournament_id, match_number),
    UNIQUE (id, tournament_id)
  );
  CREATE INDEX matches_tournament_status_start_idx ON matches (tournament_id, status, starts_at);
  CREATE INDEX matches_public_start_idx ON matches (status, starts_at) WHERE visibility = 'public';

  CREATE TABLE match_participants (
    match_id UUID NOT NULL,
    tournament_id UUID NOT NULL,
    registration_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'eligible' CHECK (status IN ('eligible', 'withdrawn', 'disqualified')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, registration_id),
    FOREIGN KEY (match_id, tournament_id) REFERENCES matches(id, tournament_id) ON DELETE CASCADE,
    FOREIGN KEY (registration_id, tournament_id) REFERENCES tournament_registrations(id, tournament_id) ON DELETE CASCADE
  );
  CREATE INDEX match_participants_registration_idx ON match_participants (registration_id, match_id);

  CREATE TABLE match_room_credentials (
    match_id UUID PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
    encrypted_room_id BYTEA,
    encrypted_password BYTEA,
    room_visible BOOLEAN NOT NULL DEFAULT false,
    visible_from TIMESTAMPTZ,
    visible_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE match_result_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('submitted', 'under_review', 'published', 'rejected', 'superseded')),
    submitted_by_user_id UUID NOT NULL REFERENCES users(id),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by_user_id UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, match_id)
  );
  CREATE INDEX match_result_submissions_status_idx ON match_result_submissions (match_id, status, submitted_at DESC);
  CREATE UNIQUE INDEX match_result_one_published_unique ON match_result_submissions (match_id) WHERE status = 'published';

  CREATE TABLE match_result_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID NOT NULL,
    match_id UUID NOT NULL,
    team_id UUID REFERENCES teams(id),
    player_id UUID REFERENCES users(id),
    winner_name_snapshot VARCHAR(120) NOT NULL DEFAULT '',
    placement INTEGER NOT NULL CHECK (placement >= 0),
    points INTEGER NOT NULL CHECK (points >= 0),
    kills INTEGER NOT NULL CHECK (kills >= 0),
    remarks VARCHAR(500) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (submission_id, match_id) REFERENCES match_result_submissions(id, match_id) ON DELETE CASCADE,
    CONSTRAINT match_result_one_winner_kind CHECK ((team_id IS NULL) <> (player_id IS NULL))
  );
  CREATE INDEX match_result_entries_match_placement_idx ON match_result_entries (match_id, placement);
`);

exports.down = (pgm) => pgm.sql(`
  DROP TABLE IF EXISTS match_result_entries;
  DROP TABLE IF EXISTS match_result_submissions;
  DROP TABLE IF EXISTS match_room_credentials;
  DROP TABLE IF EXISTS match_participants;
  DROP TABLE IF EXISTS matches;
  DROP TABLE IF EXISTS registration_members;
  DROP TABLE IF EXISTS tournament_registrations;
  DROP TABLE IF EXISTS team_invitations;
  DROP TABLE IF EXISTS team_members;
  DROP TABLE IF EXISTS teams;
  DROP TABLE IF EXISTS tournament_prize_distributions;
  DROP TABLE IF EXISTS tournament_rules;
  DROP TABLE IF EXISTS tournaments;
`);