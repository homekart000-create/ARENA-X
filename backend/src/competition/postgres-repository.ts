import type { Pool, PoolClient } from 'pg';
import {
  CompetitionError,
  type CompetitionRepository,
  type EncryptedRoomPatch,
  type InvitationView,
  type MatchInput,
  type MatchPatch,
  type MatchResultInput,
  type MatchView,
  type RegistrationView,
  type RoomCredentials,
  type TeamInput,
  type TeamMemberView,
  type TeamPatch,
  type TeamView,
  type TournamentInput,
  type TournamentPatch,
  type TournamentType,
  type TournamentView
} from './contracts.js';

type Queryable = Pool | PoolClient;

interface TournamentRow {
  id: string;
  name: string;
  game: string;
  participation_type: TournamentType;
  entry_fee_minor: string;
  prize_pool_minor: string;
  max_slots: number;
  starts_at: Date | string;
  registration_deadline: Date | string;
  status: TournamentView['status'];
  mode: string;
  description: string;
  banner_key: string | null;
  map: string;
  host_name: string;
  featured: boolean;
  created_at: Date | string;
  joined_slots?: string | number;
}

interface TeamRow {
  id: string;
  team_name: string;
  team_tag: string;
  logo_key: string;
  description: string;
  owner_user_id: string;
  status: TeamView['status'];
  created_at: Date | string;
}

interface TeamMemberRow {
  user_id: string;
  username: string;
  full_name: string;
  avatar: string | null;
  role: 'captain' | 'member';
  joined_at: Date | string;
}

interface MatchRow {
  id: string;
  tournament_id: string;
  match_number: number;
  title: string;
  game: string;
  mode: string;
  starts_at: Date | string;
  status: MatchView['status'];
  max_participants: number;
  visibility: 'public' | 'private';
  room_visible?: boolean;
  map: string;
  instructions: string;
  created_at: Date | string;
  updated_at: Date | string;
  participant_count: string | number;
  winner_name_snapshot?: string;
  placement?: number;
  points?: number;
  kills?: number;
  remarks?: string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function expectedRosterSize(type: TournamentType): number {
  return type === 'Solo' ? 1 : type === 'Duo' ? 2 : 4;
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function safeDatabaseError(error: unknown): CompetitionError {
  if (error instanceof CompetitionError) return error;
  if (isPgError(error, '23505')) return new CompetitionError(409, 'CONFLICT', 'The requested record conflicts with existing data.');
  if (isPgError(error, '23503') || isPgError(error, '23514')) return new CompetitionError(400, 'INVALID_REFERENCE', 'The request contains invalid related data.');
  return new CompetitionError(503, 'SERVICE_UNAVAILABLE', 'Competition storage is temporarily unavailable.');
}

function mapTournament(row: TournamentRow, rules: readonly string[], prizes: readonly { place: string; percentage: number }[]): TournamentView {
  return {
    id: row.id,
    name: row.name,
    game: row.game,
    type: row.participation_type,
    entryFee: Number(row.entry_fee_minor) / 100,
    prizePool: Number(row.prize_pool_minor) / 100,
    maxSlots: row.max_slots,
    joinedSlots: Number(row.joined_slots ?? 0),
    startsAt: timestamp(row.starts_at),
    registrationDeadline: timestamp(row.registration_deadline),
    status: row.status,
    mode: row.mode,
    description: row.description,
    banner: row.banner_key ?? '',
    map: row.map,
    host: row.host_name,
    rules,
    prizeDistribution: prizes,
    featured: row.featured,
    createdAt: timestamp(row.created_at)
  };
}

function mapTeam(row: TeamRow, members: readonly TeamMemberRow[]): TeamView {
  const publicMembers: TeamMemberView[] = members.map((member) => ({
    userId: member.user_id,
    username: member.username,
    fullName: member.full_name,
    avatar: member.avatar,
    role: member.role === 'captain' ? 'CAPTAIN' : 'MEMBER',
    joinedAt: timestamp(member.joined_at)
  }));
  return {
    teamId: row.id,
    teamName: row.team_name,
    teamTag: row.team_tag,
    logo: row.logo_key,
    description: row.description,
    ownerId: row.owner_user_id,
    status: row.status,
    createdAt: timestamp(row.created_at),
    members: publicMembers
  };
}

function mapMatch(row: MatchRow, result?: MatchView['result'], includeRoomVisibility = false): MatchView {
  return {
    matchId: row.id,
    tournamentId: row.tournament_id,
    matchNumber: row.match_number,
    title: row.title,
    game: row.game,
    mode: row.mode,
    startsAt: timestamp(row.starts_at),
    status: row.status,
    map: row.map,
    instructions: row.instructions,
    maxPlayers: row.max_participants,
    visibility: row.visibility,
    ...(includeRoomVisibility ? { roomVisible: row.room_visible ?? false } : {}),
    participantCount: Number(row.participant_count),
    ...(result ? { result } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

export class PostgresCompetitionRepository implements CompetitionRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw safeDatabaseError(error);
    }
    try {
      await client.query('BEGIN');
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original database failure.
      }
      throw safeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private async loadTournament(db: Queryable, id: string, includePrivate: boolean): Promise<TournamentView | null> {
    const result = await db.query<TournamentRow>(
      `SELECT t.*, COUNT(r.id) FILTER (WHERE r.status = 'registered') AS joined_slots
       FROM tournaments t
       LEFT JOIN tournament_registrations r ON r.tournament_id = t.id
       WHERE t.id = $1 AND ($2::boolean OR t.status <> 'draft')
       GROUP BY t.id`,
      [id, includePrivate]
    );
    const row = result.rows[0];
    if (!row) return null;
    const [rulesResult, prizesResult] = await Promise.all([
      db.query<{ rule_text: string }>('SELECT rule_text FROM tournament_rules WHERE tournament_id = $1 ORDER BY position', [id]),
      db.query<{ place_label: string; share_basis_points: number }>('SELECT place_label, share_basis_points FROM tournament_prize_distributions WHERE tournament_id = $1 ORDER BY position', [id])
    ]);
    return mapTournament(
      row,
      rulesResult.rows.map((rule) => rule.rule_text),
      prizesResult.rows.map((prize) => ({ place: prize.place_label, percentage: prize.share_basis_points / 100 }))
    );
  }

  private async loadTeam(db: Queryable, id: string, lock = false): Promise<TeamView | null> {
    const result = await db.query<TeamRow>(
      `SELECT id::text AS id, team_name, team_tag, logo_key, description, owner_user_id::text AS owner_user_id, status, created_at
       FROM teams WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    const members = await db.query<TeamMemberRow>(
      `SELECT tm.user_id::text AS user_id, u.username, u.full_name, u.avatar, tm.role, tm.joined_at
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 AND tm.left_at IS NULL
       ORDER BY CASE WHEN tm.role = 'captain' THEN 0 ELSE 1 END, tm.joined_at`,
      [id]
    );
    return mapTeam(row, members.rows);
  }

  private async assertRosterFitsRegistrations(db: Queryable, teamId: string, memberCount: number): Promise<void> {
    const registrations = await db.query<{ participation_type: TournamentType }>(
      `SELECT DISTINCT t.participation_type
       FROM tournament_registrations r JOIN tournaments t ON t.id = r.tournament_id
       WHERE r.team_id = $1 AND r.status = 'registered'`,
      [teamId]
    );
    if (registrations.rows.some((row) => expectedRosterSize(row.participation_type) !== memberCount)) {
      throw new CompetitionError(409, 'ROSTER_LOCKED', 'This roster change would invalidate an active tournament registration.');
    }
  }

  private async addMemberToTeam(db: Queryable, team: TeamView, userId: string): Promise<void> {
    const activeUser = await db.query('SELECT id FROM users WHERE id = $1 AND status = \'active\'', [userId]);
    if (activeUser.rowCount !== 1) throw new CompetitionError(404, 'USER_NOT_FOUND', 'Player not found.');
    const alreadyMember = await db.query('SELECT 1 FROM team_members WHERE user_id = $1 AND left_at IS NULL', [userId]);
    if (alreadyMember.rowCount) throw new CompetitionError(409, 'ALREADY_IN_TEAM', 'This player already belongs to a team.');
    const nextCount = team.members.length + 1;
    await this.assertRosterFitsRegistrations(db, team.teamId, nextCount);
    await db.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team.teamId, userId]
    );
  }

  async listTournaments(includePrivate: boolean): Promise<readonly TournamentView[]> {
    try {
      const result = await this.pool.query<{ id: string }>(
        'SELECT id::text AS id FROM tournaments WHERE $1::boolean OR status <> \'draft\' ORDER BY starts_at, created_at',
        [includePrivate]
      );
      return (await Promise.all(result.rows.map((row) => this.loadTournament(this.pool, row.id, includePrivate))))
        .filter((tournament): tournament is TournamentView => tournament !== null);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async getTournament(id: string, includePrivate: boolean): Promise<TournamentView | null> {
    try {
      return await this.loadTournament(this.pool, id, includePrivate);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async createTournament(ownerId: string, input: TournamentInput): Promise<TournamentView> {
    return this.transaction(async (client) => {
      const result = await client.query<TournamentRow>(
        `INSERT INTO tournaments (
          owner_user_id, name, game, participation_type, mode, entry_fee_minor, prize_pool_minor,
          max_slots, starts_at, registration_deadline, banner_key, description, map, host_name, featured
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING id::text AS id, name, game, participation_type, entry_fee_minor, prize_pool_minor,
          max_slots, starts_at, registration_deadline, status, mode, description, banner_key, map,
          host_name, featured, created_at`,
        [ownerId, input.name, input.game, input.type, input.mode, Math.round(input.entryFee * 100), Math.round(input.prizePool * 100), input.maxSlots, input.startsAt, input.registrationDeadline, input.banner ?? '', input.description ?? '', input.map ?? '', input.host ?? '', input.featured ?? false]
      );
      const row = result.rows[0];
      if (!row) throw new CompetitionError(503, 'SERVICE_UNAVAILABLE', 'Competition storage is temporarily unavailable.');
      await this.replaceTournamentChildren(client, row.id, input);
      return (await this.loadTournament(client, row.id, true))!;
    });
  }

  private async replaceTournamentChildren(client: PoolClient, id: string, input: Pick<TournamentInput, 'rules' | 'prizeDistribution'>): Promise<void> {
    if (input.rules !== undefined) {
      await client.query('DELETE FROM tournament_rules WHERE tournament_id = $1', [id]);
      for (const [position, rule] of input.rules.entries()) {
        await client.query('INSERT INTO tournament_rules (tournament_id, position, rule_text) VALUES ($1,$2,$3)', [id, position, rule]);
      }
    }
    if (input.prizeDistribution !== undefined) {
      await client.query('DELETE FROM tournament_prize_distributions WHERE tournament_id = $1', [id]);
      for (const [position, prize] of input.prizeDistribution.entries()) {
        await client.query(
          'INSERT INTO tournament_prize_distributions (tournament_id, position, place_label, share_basis_points) VALUES ($1,$2,$3,$4)',
          [id, position, prize.place, Math.round(prize.percentage * 100)]
        );
      }
    }
  }

  async updateTournament(id: string, input: TournamentPatch): Promise<TournamentView | null> {
    return this.transaction(async (client) => {
      const lock = await client.query('SELECT id FROM tournaments WHERE id=$1 FOR UPDATE', [id]);
      if (!lock.rowCount) return null;
      const current = await this.loadTournament(client, id, true);
      if (!current) return null;
      const next: TournamentView = { ...current, ...input };
      const registrations = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM tournament_registrations WHERE tournament_id = $1 AND status = 'registered'",
        [id]
      );
      if (next.maxSlots < Number(registrations.rows[0]?.count ?? 0)) {
        throw new CompetitionError(409, 'CAPACITY_BELOW_REGISTRATIONS', 'Capacity cannot be lower than active registrations.');
      }
      if (next.type !== current.type && Number(registrations.rows[0]?.count ?? 0) > 0) {
        throw new CompetitionError(409, 'TYPE_LOCKED', 'Participation type cannot change while registrations are active.');
      }
      await client.query(
        `UPDATE tournaments SET name=$2, game=$3, participation_type=$4, mode=$5,
          entry_fee_minor=$6, prize_pool_minor=$7, max_slots=$8, starts_at=$9,
          registration_deadline=$10, status=$11, banner_key=$12, description=$13,
          map=$14, host_name=$15, featured=$16, updated_at=now()
         WHERE id=$1`,
        [id, next.name, next.game, next.type, next.mode, Math.round(next.entryFee * 100), Math.round(next.prizePool * 100), next.maxSlots, next.startsAt, next.registrationDeadline, next.status, next.banner, next.description, next.map, next.host, next.featured]
      );
      await this.replaceTournamentChildren(client, id, input);
      return this.loadTournament(client, id, true);
    });
  }

  async registerForTournament(tournamentId: string, userId: string, teamId?: string): Promise<RegistrationView> {
    return this.transaction(async (client) => {
      let members = [userId];
      let captainId = userId;
      let team: TeamView | null = null;
      if (teamId) {
        team = await this.loadTeam(client, teamId, true);
        if (!team || team.status !== 'active') throw new CompetitionError(404, 'TEAM_NOT_FOUND', 'Team not found.');
        if (!team.members.some((member) => member.userId === userId)) throw new CompetitionError(403, 'TEAM_MEMBERSHIP_REQUIRED', 'Join this team before registering it.');
        captainId = team.ownerId;
      }

      const tournamentResult = await client.query<TournamentRow>(
        `SELECT id::text AS id, participation_type, status, max_slots, registration_deadline, entry_fee_minor
         FROM tournaments WHERE id = $1 FOR UPDATE`,
        [tournamentId]
      );
      const tournament = tournamentResult.rows[0];
      if (!tournament || tournament.status === 'draft') throw new CompetitionError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found.');
      if (!['upcoming', 'live'].includes(tournament.status)) throw new CompetitionError(400, 'REGISTRATION_CLOSED', 'Registration is not open for this tournament.');
      if (new Date(tournament.registration_deadline).getTime() < Date.now()) throw new CompetitionError(400, 'REGISTRATION_CLOSED', 'The registration deadline has passed.');
      if (BigInt(tournament.entry_fee_minor) !== 0n) {
        throw new CompetitionError(409, 'PAID_REGISTRATION_UNAVAILABLE', 'Paid tournament registration is unavailable until payment settlement is supported.');
      }

      const required = expectedRosterSize(tournament.participation_type);
      if (tournament.participation_type === 'Solo') {
        if (teamId) throw new CompetitionError(400, 'WRONG_ROSTER_SIZE', 'Solo registration must contain only the authenticated player.');
      } else {
        if (!team) throw new CompetitionError(400, 'TEAM_REQUIRED', 'A team is required for Duo and Squad registration.');
        if (team.members.length !== required) {
          throw new CompetitionError(400, 'WRONG_ROSTER_SIZE', `${tournament.participation_type} registration requires exactly ${required} team members.`);
        }
        members = team.members.map((member) => member.userId);
      }

      const slots = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM tournament_registrations WHERE tournament_id = $1 AND status = 'registered'",
        [tournamentId]
      );
      if (Number(slots.rows[0]?.count ?? 0) >= tournament.max_slots) throw new CompetitionError(409, 'TOURNAMENT_FULL', 'This tournament is full.');

      const conflict = await client.query(
        `SELECT 1 FROM registration_members rm
         JOIN tournament_registrations r ON r.id = rm.registration_id
         WHERE rm.tournament_id = $1 AND rm.user_id = ANY($2::uuid[])
           AND rm.left_at IS NULL AND r.status = 'registered' LIMIT 1`,
        [tournamentId, members]
      );
      if (conflict.rowCount) throw new CompetitionError(409, 'DUPLICATE_REGISTRATION', 'A player on this roster is already registered for this tournament.');

      const inserted = await client.query<{ id: string; registered_at: Date | string }>(
        `INSERT INTO tournament_registrations (tournament_id, captain_user_id, team_id, entry_fee_minor, currency)
         VALUES ($1,$2,$3,$4,'INR') RETURNING id::text AS id, registered_at`,
        [tournamentId, captainId, team?.teamId ?? null, tournament.entry_fee_minor]
      );
      const registration = inserted.rows[0];
      if (!registration) throw new CompetitionError(503, 'SERVICE_UNAVAILABLE', 'Competition storage is temporarily unavailable.');
      for (const [index, memberId] of members.entries()) {
        await client.query(
          `INSERT INTO registration_members (registration_id, tournament_id, user_id, role)
           VALUES ($1,$2,$3,$4)`,
          [registration.id, tournamentId, memberId, memberId === captainId || (index === 0 && tournament.participation_type === 'Solo') ? 'captain' : 'member']
        );
      }
      return {
        registrationId: registration.id,
        tournamentId,
        userId: captainId,
        teamId: team?.teamId ?? null,
        memberIds: members,
        registeredAt: timestamp(registration.registered_at),
        status: 'registered'
      };
    });
  }

  async cancelTournamentRegistration(tournamentId: string, userId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const registration = await client.query<{ id: string }>(
        `SELECT r.id::text AS id FROM tournament_registrations r
         JOIN registration_members rm ON rm.registration_id = r.id
         WHERE r.tournament_id = $1 AND r.status = 'registered' AND rm.user_id = $2 AND rm.left_at IS NULL
         FOR UPDATE OF r`,
        [tournamentId, userId]
      );
      const row = registration.rows[0];
      if (!row) return false;
      await client.query("UPDATE tournament_registrations SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [row.id]);
      await client.query('UPDATE registration_members SET left_at=now(), updated_at=now() WHERE registration_id=$1 AND left_at IS NULL', [row.id]);
      return true;
    });
  }

  async getTeam(id: string): Promise<TeamView | null> {
    try {
      const team = await this.loadTeam(this.pool, id);
      return team?.status === 'active' ? team : null;
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async createTeam(ownerId: string, input: TeamInput): Promise<TeamView> {
    return this.transaction(async (client) => {
      const current = await client.query('SELECT 1 FROM team_members WHERE user_id=$1 AND left_at IS NULL', [ownerId]);
      if (current.rowCount) throw new CompetitionError(409, 'ALREADY_IN_TEAM', 'Leave your current team before creating another.');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO teams (owner_user_id, team_name, team_tag, logo_key, description)
         VALUES ($1,$2,$3,$4,$5) RETURNING id::text AS id`,
        [ownerId, input.teamName, input.teamTag, input.logo ?? '', input.description ?? '']
      );
      const row = inserted.rows[0];
      if (!row) throw new CompetitionError(503, 'SERVICE_UNAVAILABLE', 'Competition storage is temporarily unavailable.');
      await client.query("INSERT INTO team_members (team_id,user_id,role) VALUES ($1,$2,'captain')", [row.id, ownerId]);
      return (await this.loadTeam(client, row.id))!;
    });
  }

  async updateTeam(id: string, actorId: string, input: TeamPatch, isAdmin: boolean): Promise<TeamView | null> {
    return this.transaction(async (client) => {
      const team = await this.loadTeam(client, id, true);
      if (!team) return null;
      if (!isAdmin && team.ownerId !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only this team captain may edit the team.');
      const next = { ...team, ...input };
      await client.query(
        'UPDATE teams SET team_name=$2, team_tag=$3, logo_key=$4, description=$5, updated_at=now() WHERE id=$1',
        [id, next.teamName, next.teamTag, next.logo, next.description]
      );
      return this.loadTeam(client, id);
    });
  }

  async addTeamMember(id: string, actorId: string, userId: string, isAdmin: boolean): Promise<TeamView | null> {
    return this.transaction(async (client) => {
      const team = await this.loadTeam(client, id, true);
      if (!team || team.status !== 'active') return null;
      if (!isAdmin && team.ownerId !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only this team captain may add members.');
      await this.addMemberToTeam(client, team, userId);
      return this.loadTeam(client, id);
    });
  }

  async removeTeamMember(id: string, actorId: string, userId: string, isAdmin: boolean): Promise<TeamView | null> {
    return this.transaction(async (client) => {
      const team = await this.loadTeam(client, id, true);
      if (!team) return null;
      if (!isAdmin && team.ownerId !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only this team captain may remove members.');
      const target = team.members.find((member) => member.userId === userId);
      if (!target) throw new CompetitionError(404, 'MEMBER_NOT_FOUND', 'That player is not on this team.');
      const nextMembers = team.members.filter((member) => member.userId !== userId);
      if (target.role === 'CAPTAIN' && nextMembers.length > 0) {
        throw new CompetitionError(409, 'CAPTAIN_TRANSFER_REQUIRED', 'Transfer captaincy before removing the captain.');
      }
      await this.assertRosterFitsRegistrations(client, id, nextMembers.length);
      await client.query('UPDATE team_members SET left_at=now(), updated_at=now() WHERE team_id=$1 AND user_id=$2 AND left_at IS NULL', [id, userId]);
      if (target.role === 'CAPTAIN') await client.query("UPDATE teams SET status='closed', updated_at=now() WHERE id=$1", [id]);
      return this.loadTeam(client, id);
    });
  }

  async createInvitation(id: string, actorId: string, receiverId: string, isAdmin: boolean): Promise<InvitationView> {
    return this.transaction(async (client) => {
      const team = await this.loadTeam(client, id, true);
      if (!team || team.status !== 'active') throw new CompetitionError(404, 'TEAM_NOT_FOUND', 'Team not found.');
      if (!isAdmin && team.ownerId !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only this team captain may invite players.');
      if (receiverId === team.ownerId) throw new CompetitionError(400, 'INVALID_INVITATION', 'The captain is already on this team.');
      const user = await client.query("SELECT id FROM users WHERE id=$1 AND status='active'", [receiverId]);
      if (!user.rowCount) throw new CompetitionError(404, 'USER_NOT_FOUND', 'Player not found.');
      const member = await client.query('SELECT 1 FROM team_members WHERE user_id=$1 AND left_at IS NULL', [receiverId]);
      if (member.rowCount) throw new CompetitionError(409, 'ALREADY_IN_TEAM', 'That player already belongs to a team.');
      const inserted = await client.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO team_invitations (team_id, sender_user_id, receiver_user_id)
         VALUES ($1,$2,$3) RETURNING id::text AS id, created_at`,
        [id, actorId, receiverId]
      );
      const row = inserted.rows[0];
      if (!row) throw new CompetitionError(503, 'SERVICE_UNAVAILABLE', 'Competition storage is temporarily unavailable.');
      return { invitationId: row.id, teamId: id, teamName: team.teamName, senderId: actorId, receiverId, createdAt: timestamp(row.created_at), status: 'pending' };
    });
  }

  async respondToInvitation(id: string, actorId: string, status: 'accepted' | 'declined'): Promise<InvitationView | null> {
    return this.transaction(async (client) => {
      const result = await client.query<{ id: string; team_id: string; sender_user_id: string; receiver_user_id: string; status: string; created_at: Date | string }>(
        'SELECT id::text AS id, team_id::text AS team_id, sender_user_id::text AS sender_user_id, receiver_user_id::text AS receiver_user_id, status, created_at FROM team_invitations WHERE id=$1 FOR UPDATE',
        [id]
      );
      const invitation = result.rows[0];
      if (!invitation) return null;
      if (invitation.receiver_user_id !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only the invited player may respond.');
      if (invitation.status !== 'pending') throw new CompetitionError(409, 'INVITATION_HANDLED', 'This invitation has already been handled.');
      const team = await this.loadTeam(client, invitation.team_id, true);
      if (!team || team.status !== 'active') throw new CompetitionError(404, 'TEAM_NOT_FOUND', 'Team not found.');
      if (status === 'accepted') await this.addMemberToTeam(client, team, actorId);
      await client.query('UPDATE team_invitations SET status=$2, responded_at=now(), updated_at=now() WHERE id=$1', [id, status]);
      return { invitationId: invitation.id, teamId: invitation.team_id, teamName: team.teamName, senderId: invitation.sender_user_id, receiverId: actorId, createdAt: timestamp(invitation.created_at), status };
    });
  }

  private async loadMatch(db: Queryable, id: string, includePrivate: boolean): Promise<MatchView | null> {
    const result = await db.query<MatchRow>(
      `SELECT m.id::text AS id, m.tournament_id::text AS tournament_id, m.match_number, m.title,
        m.game, m.mode, m.starts_at, m.status, m.max_participants, m.visibility, m.map, m.instructions,
        m.created_at, m.updated_at, rc.room_visible,
        (SELECT count(*) FROM match_participants mp WHERE mp.match_id=m.id AND mp.status='eligible') AS participant_count,
        entry.winner_name_snapshot, entry.placement, entry.points, entry.kills, entry.remarks
       FROM matches m
       LEFT JOIN match_room_credentials rc ON rc.match_id=m.id
       LEFT JOIN LATERAL (
         SELECT e.winner_name_snapshot, e.placement, e.points, e.kills, e.remarks
         FROM match_result_submissions s JOIN match_result_entries e ON e.submission_id=s.id
         WHERE s.match_id=m.id AND s.status='published'
         ORDER BY s.published_at DESC NULLS LAST LIMIT 1
       ) entry ON true
       WHERE m.id=$1 AND ($2::boolean OR m.visibility='public')`,
      [id, includePrivate]
    );
    const row = result.rows[0];
    if (!row) return null;
    const publicResult = row.winner_name_snapshot === undefined ? undefined : {
      winnerName: row.winner_name_snapshot,
      placement: Number(row.placement ?? 0),
      points: Number(row.points ?? 0),
      kills: Number(row.kills ?? 0),
      remarks: row.remarks ?? ''
    };
    return mapMatch(row, publicResult, includePrivate);
  }

  async listMatches(includePrivate: boolean): Promise<readonly MatchView[]> {
    try {
      const ids = await this.pool.query<{ id: string }>(
        'SELECT id::text AS id FROM matches WHERE $1::boolean OR visibility=\'public\' ORDER BY starts_at, match_number',
        [includePrivate]
      );
      return (await Promise.all(ids.rows.map((row) => this.loadMatch(this.pool, row.id, includePrivate))))
        .filter((match): match is MatchView => match !== null);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async getMatch(id: string, includePrivate: boolean): Promise<MatchView | null> {
    try {
      return await this.loadMatch(this.pool, id, includePrivate);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async createMatch(ownerId: string, input: MatchInput, roomId: Buffer | null, roomPassword: Buffer | null): Promise<MatchView> {
    return this.transaction(async (client) => {
      const tournament = await client.query('SELECT id FROM tournaments WHERE id=$1 AND status <> \'draft\' FOR UPDATE', [input.tournamentId]);
      if (!tournament.rowCount) throw new CompetitionError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found.');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO matches (tournament_id, match_number, title, game, mode, starts_at, status, max_participants,
          visibility, map, instructions, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::text AS id`,
        [input.tournamentId, input.matchNumber, input.title, input.game, input.mode, input.startsAt, input.status ?? 'upcoming', input.maxPlayers, input.visibility ?? 'public', input.map ?? '', input.instructions ?? '', ownerId]
      );
      const row = inserted.rows[0];
      if (!row) throw new CompetitionError(503, 'SERVICE_UNAVAILABLE', 'Competition storage is temporarily unavailable.');
      const registrationIds = input.registrationIds ?? (await client.query<{ id: string }>(
        "SELECT id::text AS id FROM tournament_registrations WHERE tournament_id=$1 AND status='registered' ORDER BY registered_at FOR UPDATE",
        [input.tournamentId]
      )).rows.map((entry) => entry.id);
      if (registrationIds.length > input.maxPlayers) throw new CompetitionError(400, 'MATCH_CAPACITY_EXCEEDED', 'Selected registrations exceed match capacity.');
      const validIds = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM tournament_registrations WHERE tournament_id=$1 AND status='registered' AND id=ANY($2::uuid[]) FOR UPDATE",
        [input.tournamentId, registrationIds]
      );
      if (validIds.rowCount !== new Set(registrationIds).size) throw new CompetitionError(400, 'INVALID_PARTICIPANTS', 'One or more selected registrations are invalid.');
      for (const registrationId of new Set(registrationIds)) {
        await client.query('INSERT INTO match_participants (match_id,tournament_id,registration_id) VALUES ($1,$2,$3)', [row.id, input.tournamentId, registrationId]);
      }
      if (roomId || roomPassword || input.roomVisible) {
        await client.query(
          'INSERT INTO match_room_credentials (match_id, encrypted_room_id, encrypted_password, room_visible) VALUES ($1,$2,$3,$4)',
          [row.id, roomId, roomPassword, input.roomVisible ?? false]
        );
      }
      return (await this.loadMatch(client, row.id, true))!;
    });
  }

  async updateMatch(id: string, input: MatchPatch, credentials: EncryptedRoomPatch): Promise<MatchView | null> {
    return this.transaction(async (client) => {
      const current = await client.query<MatchRow>(
        `SELECT id::text AS id, tournament_id::text AS tournament_id, match_number, title, game, mode, starts_at,
          status, max_participants, visibility, map, instructions, created_at, updated_at, 0 AS participant_count
         FROM matches WHERE id=$1 FOR UPDATE`,
        [id]
      );
      const row = current.rows[0];
      if (!row) return null;
      const nextMaxPlayers = input.maxPlayers ?? row.max_participants;
      if (input.registrationIds !== undefined) {
        if (input.registrationIds.length > nextMaxPlayers) throw new CompetitionError(400, 'MATCH_CAPACITY_EXCEEDED', 'Selected registrations exceed match capacity.');
        const validIds = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM tournament_registrations WHERE tournament_id=$1 AND status='registered' AND id=ANY($2::uuid[]) FOR UPDATE",
          [row.tournament_id, input.registrationIds]
        );
        if (validIds.rowCount !== new Set(input.registrationIds).size) throw new CompetitionError(400, 'INVALID_PARTICIPANTS', 'One or more selected registrations are invalid.');
        await client.query('DELETE FROM match_participants WHERE match_id=$1', [id]);
        for (const registrationId of new Set(input.registrationIds)) {
          await client.query('INSERT INTO match_participants (match_id,tournament_id,registration_id) VALUES ($1,$2,$3)', [id, row.tournament_id, registrationId]);
        }
      }
      const currentParticipants = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM match_participants WHERE match_id=$1 AND status='eligible'", [id]);
      if (Number(currentParticipants.rows[0]?.count ?? 0) > nextMaxPlayers && input.registrationIds === undefined) {
        throw new CompetitionError(409, 'MATCH_CAPACITY_BELOW_PARTICIPANTS', 'Capacity cannot be lower than selected registrations.');
      }
      await client.query(
        `UPDATE matches SET title=$2, game=$3, mode=$4, starts_at=$5, status=$6,
          max_participants=$7, visibility=$8, map=$9, instructions=$10, updated_at=now() WHERE id=$1`,
        [id, input.title ?? row.title, input.game ?? row.game, input.mode ?? row.mode, input.startsAt ?? row.starts_at, input.status ?? row.status, nextMaxPlayers, input.visibility ?? row.visibility, input.map ?? row.map, input.instructions ?? row.instructions]
      );
      const previous = await client.query<{ encrypted_room_id: Buffer | null; encrypted_password: Buffer | null; room_visible: boolean }>(
        'SELECT encrypted_room_id, encrypted_password, room_visible FROM match_room_credentials WHERE match_id=$1 FOR UPDATE',
        [id]
      );
      const prior = previous.rows[0];
      const nextRoomId = credentials.roomId === undefined ? prior?.encrypted_room_id ?? null : credentials.roomId;
      const nextPassword = credentials.roomPassword === undefined ? prior?.encrypted_password ?? null : credentials.roomPassword;
      const roomVisible = input.roomVisible ?? prior?.room_visible ?? false;
      if (prior || nextRoomId || nextPassword || input.roomVisible !== undefined) {
        await client.query(
          `INSERT INTO match_room_credentials (match_id, encrypted_room_id, encrypted_password, room_visible)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (match_id) DO UPDATE SET encrypted_room_id=EXCLUDED.encrypted_room_id,
             encrypted_password=EXCLUDED.encrypted_password, room_visible=EXCLUDED.room_visible, updated_at=now()`,
          [id, nextRoomId, nextPassword, roomVisible]
        );
      }
      return this.loadMatch(client, id, true);
    });
  }

  async setMatchResult(id: string, submittedByUserId: string, input: MatchResultInput): Promise<MatchView | null> {
    return this.transaction(async (client) => {
      const match = await client.query<{ id: string; status: MatchView['status'] }>('SELECT id::text AS id, status FROM matches WHERE id=$1 FOR UPDATE', [id]);
      if (!match.rows[0]) return null;
      if (Boolean(input.teamId) === Boolean(input.playerId)) throw new CompetitionError(400, 'INVALID_RESULT', 'Choose exactly one registered player or team.');
      let winnerName = input.winnerName?.trim() ?? '';
      if (input.teamId) {
        const participant = await client.query<{ team_name: string }>(
          `SELECT t.team_name FROM match_participants mp
           JOIN tournament_registrations r ON r.id=mp.registration_id
           JOIN teams t ON t.id=r.team_id
           WHERE mp.match_id=$1 AND mp.status='eligible' AND r.team_id=$2 LIMIT 1`,
          [id, input.teamId]
        );
        if (!participant.rows[0]) throw new CompetitionError(400, 'INVALID_RESULT_PARTICIPANT', 'The selected team is not registered for this match.');
        winnerName = participant.rows[0].team_name;
      } else if (input.playerId) {
        const participant = await client.query<{ username: string }>(
          `SELECT u.username FROM match_participants mp
           JOIN registration_members rm ON rm.registration_id=mp.registration_id
           JOIN users u ON u.id=rm.user_id
           WHERE mp.match_id=$1 AND mp.status='eligible' AND rm.user_id=$2 AND rm.left_at IS NULL LIMIT 1`,
          [id, input.playerId]
        );
        if (!participant.rows[0]) throw new CompetitionError(400, 'INVALID_RESULT_PARTICIPANT', 'The selected player is not registered for this match.');
        winnerName = participant.rows[0].username;
      }
      if (input.status === 'published') await client.query("UPDATE match_result_submissions SET status='superseded', updated_at=now() WHERE match_id=$1 AND status='published'", [id]);
      const submission = await client.query<{ id: string }>(
        'INSERT INTO match_result_submissions (match_id,status,submitted_by_user_id,reviewed_by_user_id,reviewed_at,published_at) VALUES ($1,$2,$3,$3,now(),CASE WHEN $2=\'published\' THEN now() ELSE NULL END) RETURNING id::text AS id',
        [id, input.status, submittedByUserId]
      );
      const submissionId = submission.rows[0]?.id;
      if (!submissionId) throw new CompetitionError(503, 'SERVICE_UNAVAILABLE', 'Competition storage is temporarily unavailable.');
      await client.query(
        `INSERT INTO match_result_entries (submission_id,match_id,team_id,player_id,winner_name_snapshot,placement,points,kills,remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [submissionId, id, input.teamId ?? null, input.playerId ?? null, winnerName, input.placement, input.points, input.kills, input.remarks ?? '']
      );
      await client.query('UPDATE matches SET result_status=$2, updated_at=now() WHERE id=$1', [id, input.status]);
      return this.loadMatch(client, id, true);
    });
  }

  async getRoomCredentials(id: string, userId: string, isAdmin: boolean, decrypt: (roomId: Buffer, password: Buffer) => RoomCredentials): Promise<RoomCredentials | null> {
    try {
      const result = await this.pool.query<{ encrypted_room_id: Buffer | null; encrypted_password: Buffer | null; room_visible: boolean; status: MatchView['status']; participant: boolean }>(
        `SELECT rc.encrypted_room_id, rc.encrypted_password, rc.room_visible, m.status,
          EXISTS (
            SELECT 1 FROM match_participants mp
            JOIN registration_members rm ON rm.registration_id=mp.registration_id
            WHERE mp.match_id=m.id AND mp.status='eligible' AND rm.user_id=$2 AND rm.left_at IS NULL
          ) AS participant
         FROM matches m JOIN match_room_credentials rc ON rc.match_id=m.id WHERE m.id=$1`,
        [id, userId]
      );
      const row = result.rows[0];
      if (!row || !row.room_visible || !['upcoming', 'live'].includes(row.status) || (!isAdmin && !row.participant)) return null;
      return decrypt(row.encrypted_room_id ?? Buffer.alloc(0), row.encrypted_password ?? Buffer.alloc(0));
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }
}