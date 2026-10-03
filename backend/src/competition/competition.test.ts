import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config/env.js';
import { parseEnvironment } from '../config/env.js';
import type { AuthRepository, AuthUser, NewUserInput, StoredCredentials } from '../auth/contracts.js';
import { DuplicateAccountError } from '../auth/contracts.js';
import { hashSessionToken } from '../auth/session.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type {
  CompetitionRepository,
  EncryptedRoomPatch,
  InvitationView,
  MatchInput,
  MatchPatch,
  MatchResultInput,
  MatchView,
  RegisteredParticipantView,
  RegistrationView,
  RoomCredentials,
  TeamInput,
  TeamMemberView,
  TeamPatch,
  TeamView,
  TournamentInput,
  TournamentPatch,
  TournamentStatus,
  TournamentType,
  TournamentView,
  UserNotificationView
} from './contracts.js';
import { CompetitionError } from './contracts.js';

const TEST_PASSWORD = 'competition-test-password';
const HASHED_TEST_PASSWORD = hashPassword(TEST_PASSWORD);
const TEST_ORIGIN = 'http://localhost:5500';
const ROOM_KEY = Buffer.alloc(32, 17);
const MODE_SIZE: Record<TournamentType, number> = { Solo: 1, Duo: 2, Squad: 4 };

class TestAuthRepository implements AuthRepository {
  private readonly users = new Map<string, StoredCredentials>();
  private readonly sessions = new Map<string, string>();

  async addTestUser(role: 'user' | 'admin' = 'user', status = 'active'): Promise<AuthUser> {
    const user: AuthUser = {
      userId: randomUUID(), fullName: `${role} test player`, username: `${role}_${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@example.test`, avatar: null, role, status, createdAt: new Date().toISOString()
    };
    this.users.set(user.userId, { user, passwordHash: await HASHED_TEST_PASSWORD });
    return user;
  }

  async createUser(input: NewUserInput): Promise<AuthUser> {
    const duplicate = [...this.users.values()].some(({ user }) => user.email === input.email || user.username === input.username);
    if (duplicate) throw new DuplicateAccountError();
    const user: AuthUser = {
      userId: randomUUID(), fullName: input.fullName, username: input.username, email: input.email,
      avatar: input.avatar, role: 'user', status: 'active', createdAt: new Date().toISOString()
    };
    this.users.set(user.userId, { user, passwordHash: input.passwordHash });
    return user;
  }

  async findByIdentifier(identifier: string): Promise<StoredCredentials | null> {
    return [...this.users.values()].find(({ user }) => user.email === identifier || user.username === identifier) ?? null;
  }

  async createSession(userId: string, tokenHash: Buffer): Promise<void> {
    this.sessions.set(tokenHash.toString('hex'), userId);
  }

  async findSessionUser(tokenHash: Buffer): Promise<AuthUser | null> {
    const userId = this.sessions.get(tokenHash.toString('hex'));
    const user = userId ? this.users.get(userId)?.user : null;
    return user?.status === 'active' ? user : null;
  }

  async revokeSession(tokenHash: Buffer): Promise<void> {
    this.sessions.delete(tokenHash.toString('hex'));
  }

  async closeOwnAccount(_userId: string): Promise<boolean> { return false; }
}

interface MemoryTeam extends TeamView {}
interface MemoryRegistration extends RegistrationView {}
interface MemoryEntryFee {
  readonly payerUserId: string;
  readonly amountMinor: number;
  readonly transactionId: string;
}
interface MemoryMatch extends MatchView {
  readonly registrationIds: readonly string[];
  readonly roomIdCipher: Buffer | null;
  readonly roomPasswordCipher: Buffer | null;
  readonly roomVisible: boolean;
  readonly resultStatus: 'pending' | 'submitted' | 'published';
  readonly submittedResult?: MatchView['result'];
  readonly submittedResults?: MatchView['results'];
}

class MemoryCompetitionRepository implements CompetitionRepository {
  readonly users = new Set<string>();
  readonly usernames = new Map<string, string>();
  readonly tournaments = new Map<string, TournamentView>();
  readonly teams = new Map<string, MemoryTeam>();
  readonly invitations = new Map<string, InvitationView>();
  readonly registrations = new Map<string, MemoryRegistration>();
  readonly matches = new Map<string, MemoryMatch>();
  readonly notifications = new Map<string, UserNotificationView & { userId: string; notificationKey: string }>();
  readonly walletBalances = new Map<string, number>();
  readonly entryFees = new Map<string, MemoryEntryFee>();
  walletWrites = 0;
  failRegistrationAfterEntryDebit = false;

  async addUser(userId: string, username: string): Promise<void> {
    this.users.add(userId);
    this.usernames.set(userId, username);
  }

  seedTournament(type: TournamentType = 'Solo', status: TournamentStatus = 'upcoming', entryFee = 0): TournamentView {
    const tournament: TournamentView = {
      id: randomUUID(), name: `Test ${type} event`, game: 'Free Fire', type, entryFee, prizePool: 100,
      maxSlots: 8, joinedSlots: 0, startsAt: new Date(Date.now() + 86400000).toISOString(),
      registrationDeadline: new Date(Date.now() + 3600000).toISOString(), status, mode: 'Battle Royale',
      description: '', banner: '', map: '', host: '', rules: [], prizeDistribution: [], featured: false,
      createdAt: new Date().toISOString()
    };
    this.tournaments.set(tournament.id, tournament);
    return tournament;
  }

  async listTournaments(includePrivate: boolean): Promise<readonly TournamentView[]> {
    return [...this.tournaments.values()].filter((entry) => includePrivate || entry.status !== 'draft');
  }

  async getTournament(id: string, includePrivate: boolean): Promise<TournamentView | null> {
    const tournament = this.tournaments.get(id);
    return tournament && (includePrivate || tournament.status !== 'draft') ? tournament : null;
  }

  async createTournament(_ownerId: string, input: TournamentInput): Promise<TournamentView> {
    const tournament = this.seedTournament(input.type);
    const created: TournamentView = { ...tournament, ...input, id: tournament.id, joinedSlots: 0, status: 'upcoming', createdAt: new Date().toISOString(), rules: input.rules ?? [], prizeDistribution: input.prizeDistribution ?? [] };
    this.tournaments.set(created.id, created);
    return created;
  }

  async updateTournament(id: string, input: TournamentPatch): Promise<TournamentView | null> {
    const current = this.tournaments.get(id);
    if (!current) return null;
    const next = { ...current, ...input };
    if (next.maxSlots < current.joinedSlots) throw new CompetitionError(409, 'CAPACITY_BELOW_REGISTRATIONS', 'Capacity is below current registrations.');
    if (next.type !== current.type && current.joinedSlots > 0) throw new CompetitionError(409, 'TYPE_LOCKED', 'Participation type is locked by active registrations.');
    this.tournaments.set(id, next);
    return next;
  }

  async registerForTournament(tournamentId: string, userId: string, teamId?: string): Promise<RegistrationView> {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status === 'draft') throw new CompetitionError(404, 'NOT_FOUND', 'Tournament not found.');
    if (!this.users.has(userId)) throw new CompetitionError(404, 'USER_NOT_FOUND', 'Player not found.');
    let members = [userId];
    let resolvedTeam: MemoryTeam | undefined;
    if (teamId) {
      resolvedTeam = this.teams.get(teamId);
      if (!resolvedTeam || !resolvedTeam.members.some((member) => member.userId === userId)) throw new CompetitionError(403, 'TEAM_MEMBERSHIP_REQUIRED', 'Join this team before registering it.');
    }
    if (tournament.type === 'Solo') {
      if (teamId) throw new CompetitionError(400, 'WRONG_ROSTER_SIZE', 'Solo registration must contain one player.');
    } else {
      if (!resolvedTeam) throw new CompetitionError(400, 'TEAM_REQUIRED', 'A team is required.');
      if (resolvedTeam.members.length !== MODE_SIZE[tournament.type]) throw new CompetitionError(400, 'WRONG_ROSTER_SIZE', `${tournament.type} requires exactly ${MODE_SIZE[tournament.type]} players.`);
      members = resolvedTeam.members.map((member) => member.userId);
    }
    const existing = [...this.registrations.values()].find((registration) =>
      registration.tournamentId === tournamentId && registration.status === 'registered'
      && registration.memberIds.includes(userId));
    if (existing) return { ...existing, replayed: true };
    if (tournament.joinedSlots >= tournament.maxSlots) throw new CompetitionError(409, 'TOURNAMENT_FULL', 'Tournament is full.');
    if ([...this.registrations.values()].some((registration) => registration.tournamentId === tournamentId && registration.status === 'registered' && registration.memberIds.some((memberId) => members.includes(memberId)))) {
      throw new CompetitionError(409, 'DUPLICATE_REGISTRATION', 'A player is already registered.');
    }
    const entryFeeMinor = Math.round(tournament.entryFee * 100);
    const availableBalance = this.walletBalances.get(userId) ?? 0;
    if (entryFeeMinor > availableBalance) throw new CompetitionError(409, 'INSUFFICIENT_FUNDS', 'Available wallet balance is insufficient.');
    const registrationId = randomUUID();
    if (entryFeeMinor > 0) {
      this.walletBalances.set(userId, availableBalance - entryFeeMinor);
      this.walletWrites += 1;
      this.entryFees.set(registrationId, { payerUserId: userId, amountMinor: entryFeeMinor, transactionId: randomUUID() });
    }
    if (this.failRegistrationAfterEntryDebit) {
      this.failRegistrationAfterEntryDebit = false;
      if (entryFeeMinor > 0) {
        this.walletBalances.set(userId, availableBalance);
        this.walletWrites -= 1;
        this.entryFees.delete(registrationId);
      }
      throw new CompetitionError(503, 'SERVICE_UNAVAILABLE', 'Competition storage is temporarily unavailable.');
    }
    const registration: RegistrationView = {
      registrationId, tournamentId, userId: resolvedTeam?.ownerId ?? userId,
      teamId: resolvedTeam?.teamId ?? null, memberIds: members, registeredAt: new Date().toISOString(),
      status: 'registered', replayed: false
    };
    this.registrations.set(registration.registrationId, registration);
    this.tournaments.set(tournamentId, { ...tournament, joinedSlots: tournament.joinedSlots + 1 });
    return registration;
  }

  async cancelTournamentRegistration(tournamentId: string, userId: string): Promise<boolean> {
    const entry = [...this.registrations.entries()].find(([, registration]) => registration.tournamentId === tournamentId && registration.status === 'registered' && registration.memberIds.includes(userId));
    if (!entry) return false;
    const [registrationId, registration] = entry;
    const fee = this.entryFees.get(registrationId);
    if (fee) {
      this.walletBalances.set(fee.payerUserId, (this.walletBalances.get(fee.payerUserId) ?? 0) + fee.amountMinor);
      this.walletWrites += 1;
      this.entryFees.delete(registrationId);
    }
    this.registrations.delete(registrationId);
    const tournament = this.tournaments.get(tournamentId);
    if (tournament) this.tournaments.set(tournamentId, { ...tournament, joinedSlots: Math.max(0, tournament.joinedSlots - 1) });
    void registration;
    return true;
  }

  async getTeam(id: string): Promise<TeamView | null> {
    const team = this.teams.get(id);
    return team?.status === 'active' ? team : null;
  }

  async createTeam(ownerId: string, input: TeamInput): Promise<TeamView> {
    if (!this.users.has(ownerId)) throw new CompetitionError(404, 'USER_NOT_FOUND', 'User not found.');
    if ([...this.teams.values()].some((team) => team.status === 'active' && team.members.some((member) => member.userId === ownerId))) throw new CompetitionError(409, 'ALREADY_IN_TEAM', 'User already belongs to a team.');
    const id = randomUUID();
    const user = [...this.users].indexOf(ownerId);
    void user;
    const team: MemoryTeam = {
      teamId: id, teamName: input.teamName, teamTag: input.teamTag, logo: input.logo ?? '', description: input.description ?? '',
      ownerId, status: 'active', createdAt: new Date().toISOString(),
      members: [{ userId: ownerId, username: this.usernames.get(ownerId) ?? 'test-player', fullName: 'Test Player', avatar: null, role: 'CAPTAIN', joinedAt: new Date().toISOString() }]
    };
    this.teams.set(id, team);
    return team;
  }

  private assertRosterSizeChange(teamId: string, nextSize: number): void {
    const active = [...this.registrations.values()].filter((registration) => registration.teamId === teamId && registration.status === 'registered');
    if (active.some((registration) => {
      const tournament = this.tournaments.get(registration.tournamentId);
      return tournament && MODE_SIZE[tournament.type] !== nextSize;
    })) throw new CompetitionError(409, 'ROSTER_LOCKED', 'The change would invalidate an active registration.');
  }

  async updateTeam(id: string, actorId: string, input: TeamPatch, isAdmin: boolean): Promise<TeamView | null> {
    const team = this.teams.get(id);
    if (!team) return null;
    if (!isAdmin && team.ownerId !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only the captain may edit this team.');
    const updated = { ...team, ...input };
    this.teams.set(id, updated);
    return updated;
  }

  async addTeamMember(id: string, actorId: string, userId: string, isAdmin: boolean): Promise<TeamView | null> {
    const team = this.teams.get(id);
    if (!team || team.status !== 'active') return null;
    if (!isAdmin && team.ownerId !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only the captain may add members.');
    if (!this.users.has(userId)) throw new CompetitionError(404, 'USER_NOT_FOUND', 'User not found.');
    if (team.members.some((member) => member.userId === userId)) throw new CompetitionError(409, 'DUPLICATE_MEMBER', 'User is already a team member.');
    if ([...this.teams.values()].some((entry) => entry.status === 'active' && entry.members.some((member) => member.userId === userId))) throw new CompetitionError(409, 'ALREADY_IN_TEAM', 'User already belongs to a team.');
    this.assertRosterSizeChange(id, team.members.length + 1);
    const updated: MemoryTeam = { ...team, members: [...team.members, { userId, username: this.usernames.get(userId) ?? 'test-player', fullName: 'Test Player', avatar: null, role: 'MEMBER', joinedAt: new Date().toISOString() }] };
    this.teams.set(id, updated);
    return updated;
  }

  async removeTeamMember(id: string, actorId: string, userId: string, isAdmin: boolean): Promise<TeamView | null> {
    const team = this.teams.get(id);
    if (!team) return null;
    if (!isAdmin && team.ownerId !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only the captain may remove members.');
    const target = team.members.find((member) => member.userId === userId);
    if (!target) throw new CompetitionError(404, 'MEMBER_NOT_FOUND', 'Member not found.');
    const members = team.members.filter((member) => member.userId !== userId);
    if (target.role === 'CAPTAIN' && members.length > 0) throw new CompetitionError(409, 'CAPTAIN_TRANSFER_REQUIRED', 'Transfer the captain role first.');
    this.assertRosterSizeChange(id, members.length);
    const updated = { ...team, status: target.role === 'CAPTAIN' ? 'closed' : team.status, members } as MemoryTeam;
    this.teams.set(id, updated);
    return updated;
  }

  async createInvitation(id: string, actorId: string, receiverId: string, isAdmin: boolean): Promise<InvitationView> {
    const team = this.teams.get(id);
    if (!team || team.status !== 'active') throw new CompetitionError(404, 'TEAM_NOT_FOUND', 'Team not found.');
    if (!isAdmin && team.ownerId !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only the captain may invite players.');
    if (!this.users.has(receiverId)) throw new CompetitionError(404, 'USER_NOT_FOUND', 'Player not found.');
    if ([...this.invitations.values()].some((invite) => invite.teamId === id && invite.receiverId === receiverId && invite.status === 'pending')) throw new CompetitionError(409, 'DUPLICATE_INVITATION', 'Invitation already pending.');
    const invitation: InvitationView = { invitationId: randomUUID(), teamId: id, teamName: team.teamName, senderId: actorId, receiverId, createdAt: new Date().toISOString(), status: 'pending' };
    this.invitations.set(invitation.invitationId, invitation);
    return invitation;
  }

  async respondToInvitation(id: string, actorId: string, status: 'accepted' | 'declined'): Promise<InvitationView | null> {
    const invitation = this.invitations.get(id);
    if (!invitation) return null;
    if (invitation.receiverId !== actorId) throw new CompetitionError(403, 'FORBIDDEN', 'Only the invited player may respond.');
    if (invitation.status !== 'pending') throw new CompetitionError(409, 'INVITATION_HANDLED', 'Invitation already handled.');
    if (status === 'accepted') {
      const team = this.teams.get(invitation.teamId);
      if (!team) throw new CompetitionError(404, 'TEAM_NOT_FOUND', 'Team not found.');
      if (team.members.some((member) => member.userId === actorId)) throw new CompetitionError(409, 'DUPLICATE_MEMBER', 'User is already a member.');
      if ([...this.teams.values()].some((entry) => entry.status === 'active' && entry.members.some((member) => member.userId === actorId))) throw new CompetitionError(409, 'ALREADY_IN_TEAM', 'User already belongs to a team.');
      this.assertRosterSizeChange(team.teamId, team.members.length + 1);
      this.teams.set(team.teamId, { ...team, members: [...team.members, { userId: actorId, username: this.usernames.get(actorId) ?? 'test-player', fullName: 'Test Player', avatar: null, role: 'MEMBER', joinedAt: new Date().toISOString() }] });
    }
    const updated = { ...invitation, status };
    this.invitations.set(id, updated);
    return updated;
  }

  private publicMatch(match: MemoryMatch, includeRoomVisibility = false): MatchView {
    const { roomIdCipher: _roomId, roomPasswordCipher: _password, roomVisible: _visible, submittedResult: _submitted, submittedResults: _submittedResults, ...publicFields } = match;
    void _roomId; void _password; void _visible; void _submitted; void _submittedResults;
    const projection = {
      ...publicFields,
      ...(includeRoomVisibility ? { roomVisible: match.roomVisible } : {})
    };
    return match.resultStatus === 'published' && match.submittedResults?.[0]
      ? { ...projection, result: match.submittedResults[0], results: match.submittedResults }
      : projection;
  }

  async listMatches(includePrivate: boolean): Promise<readonly MatchView[]> {
    return [...this.matches.values()].filter((match) => includePrivate || match.visibility === 'public').map((match) => this.publicMatch(match, includePrivate));
  }

  async getMatch(id: string, includePrivate: boolean, userId?: string): Promise<MatchView | null> {
    const match = this.matches.get(id);
    const participant = Boolean(userId && match?.registrationIds.some((registrationId) =>
      this.registrations.get(registrationId)?.memberIds.includes(userId)
    ));
    return match && (includePrivate || match.visibility === 'public' || participant) ? this.publicMatch(match, includePrivate) : null;
  }

  async listMyMatches(userId: string): Promise<readonly MatchView[]> {
    return [...this.matches.values()]
      .filter((match) => match.registrationIds.some((registrationId) =>
        this.registrations.get(registrationId)?.status === 'registered'
        && this.registrations.get(registrationId)?.memberIds.includes(userId)
      ))
      .map((match) => this.publicMatch(match));
  }

  private participants(registrationIds: readonly string[]): RegisteredParticipantView[] {
    return registrationIds.flatMap((registrationId) => {
      const registration = this.registrations.get(registrationId);
      if (!registration || registration.status !== 'registered') return [];
      const team = registration.teamId ? this.teams.get(registration.teamId) : null;
      return [{
        registrationId,
        teamId: registration.teamId,
        teamName: team?.teamName ?? null,
        players: registration.memberIds.map((userId) => ({ userId, username: this.usernames.get(userId) ?? 'player' }))
      }];
    });
  }

  async listTournamentParticipants(tournamentId: string): Promise<readonly RegisteredParticipantView[] | null> {
    if (!this.tournaments.has(tournamentId)) return null;
    return this.participants([...this.registrations.values()]
      .filter((registration) => registration.tournamentId === tournamentId)
      .map((registration) => registration.registrationId));
  }

  async listMatchParticipants(matchId: string): Promise<readonly RegisteredParticipantView[] | null> {
    const match = this.matches.get(matchId);
    return match ? this.participants(match.registrationIds) : null;
  }

  async publishMatchNotifications(matchId: string): Promise<number | null> {
    const match = this.matches.get(matchId);
    if (!match) return null;
    if (!match.roomIdCipher || !match.roomPasswordCipher || !['upcoming', 'live'].includes(match.status)) {
      return null;
    }
    this.matches.set(matchId, { ...match, roomVisible: true });
    let created = 0;
    const registrations = match.registrationIds
      .map((registrationId) => this.registrations.get(registrationId))
      .filter((registration) => registration?.status === 'registered');
    for (const registration of registrations) {
      for (const userId of registration!.memberIds) {
        const notificationKey = `match-room:${matchId}`;
        const key = `${userId}:${notificationKey}`;
        if (this.notifications.has(key)) continue;
        this.notifications.set(key, {
          id: randomUUID(), userId, notificationKey, type: 'match_room_available',
          title: 'Match room available',
          message: 'Room credentials are available for your registered match. Open the match to view them securely.',
          relatedId: matchId, createdAt: new Date().toISOString(), read: false
        });
        created += 1;
      }
    }
    return created;
  }

  async listNotifications(userId: string): Promise<readonly UserNotificationView[]> {
    return [...this.notifications.values()].filter((item) => item.userId === userId)
      .map(({ userId: _userId, notificationKey: _key, ...item }) => item);
  }

  async markNotificationRead(userId: string, notificationId: string): Promise<boolean> {
    const entry = [...this.notifications.entries()].find(([, item]) => item.userId === userId && item.id === notificationId);
    if (!entry) return false;
    const [key, item] = entry;
    this.notifications.set(key, { ...item, read: true });
    return true;
  }

  async createMatch(ownerId: string, input: MatchInput, roomId: Buffer | null, roomPassword: Buffer | null): Promise<MatchView> {
    if (!this.tournaments.has(input.tournamentId)) throw new CompetitionError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found.');
    const selected = input.registrationIds ?? [...this.registrations.values()].filter((registration) => registration.tournamentId === input.tournamentId).map((registration) => registration.registrationId);
    if (selected.some((registrationId) => this.registrations.get(registrationId)?.tournamentId !== input.tournamentId)) throw new CompetitionError(400, 'INVALID_PARTICIPANTS', 'Selected registrations are invalid.');
    if (selected.length > input.maxPlayers) throw new CompetitionError(400, 'MATCH_CAPACITY_EXCEEDED', 'Selected registrations exceed match capacity.');
    const match: MemoryMatch = {
      matchId: randomUUID(), tournamentId: input.tournamentId, matchNumber: input.matchNumber,
      title: input.title, game: input.game, mode: input.mode, startsAt: input.startsAt,
      status: input.status ?? 'upcoming', map: input.map ?? '', instructions: input.instructions ?? '',
      maxPlayers: input.maxPlayers, visibility: input.visibility ?? 'public', participantCount: selected.length,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      registrationIds: selected, roomIdCipher: roomId, roomPasswordCipher: roomPassword,
      roomVisible: input.roomVisible ?? false, resultStatus: 'pending'
    };
    this.matches.set(match.matchId, match);
    void ownerId;
    return this.publicMatch(match, true);
  }

  async updateMatch(id: string, input: MatchPatch, credentials: EncryptedRoomPatch): Promise<MatchView | null> {
    const match = this.matches.get(id);
    if (!match) return null;
    if ((input.registrationIds?.length ?? match.participantCount) > (input.maxPlayers ?? match.maxPlayers)) throw new CompetitionError(400, 'MATCH_CAPACITY_EXCEEDED', 'Selected registrations exceed match capacity.');
    const updated: MemoryMatch = {
      ...match,
      ...input,
      registrationIds: input.registrationIds ?? match.registrationIds,
      participantCount: input.registrationIds?.length ?? match.participantCount,
      roomIdCipher: credentials.roomId === undefined ? match.roomIdCipher : credentials.roomId,
      roomPasswordCipher: credentials.roomPassword === undefined ? match.roomPasswordCipher : credentials.roomPassword,
      roomVisible: credentials.roomId !== undefined || credentials.roomPassword !== undefined
        ? false
        : input.roomVisible ?? match.roomVisible,
      updatedAt: new Date().toISOString()
    };
    this.matches.set(id, updated);
    return this.publicMatch(updated, true);
  }

  async setMatchResult(id: string, _submittedByUserId: string, input: MatchResultInput): Promise<MatchView | null> {
    const match = this.matches.get(id);
    if (!match) return null;
    const entries = input.entries ?? (input.placement !== undefined && input.points !== undefined && input.kills !== undefined ? [input as MatchResultInput & { placement: number; points: number; kills: number }] : []);
    const results = entries.map((entry) => {
      if (Boolean(entry.teamId) === Boolean(entry.playerId)) throw new CompetitionError(400, 'INVALID_RESULT', 'Choose exactly one participant.');
      if (entry.teamId && !match.registrationIds.some((registrationId) => this.registrations.get(registrationId)?.status === 'registered' && this.registrations.get(registrationId)?.teamId === entry.teamId)) throw new CompetitionError(400, 'INVALID_RESULT_PARTICIPANT', 'Team is not a match participant.');
      if (entry.playerId && !match.registrationIds.some((registrationId) => this.registrations.get(registrationId)?.status === 'registered' && this.registrations.get(registrationId)?.memberIds.includes(entry.playerId!))) throw new CompetitionError(400, 'INVALID_RESULT_PARTICIPANT', 'Player is not a match participant.');
      const winningTeam = entry.teamId ? this.teams.get(entry.teamId) : undefined;
      const winnerName = winningTeam?.teamName ?? (entry.playerId ? this.usernames.get(entry.playerId) : undefined) ?? 'Test winner';
      return { winnerName, placement: entry.placement, points: entry.points, kills: entry.kills, remarks: entry.remarks ?? '' };
    });
    const updated: MemoryMatch = { ...match, resultStatus: input.status, ...(input.status === 'published' ? { submittedResult: results[0], submittedResults: results } : {}), updatedAt: new Date().toISOString() };
    this.matches.set(id, updated);
    return this.publicMatch(updated, true);
  }

  async getRoomCredentials(id: string, userId: string, isAdmin: boolean, decrypt: (roomId: Buffer, password: Buffer) => RoomCredentials): Promise<RoomCredentials | null> {
    const match = this.matches.get(id);
    if (!match || !match.roomVisible || !['upcoming', 'live'].includes(match.status)) return null;
    const participant = match.registrationIds.some((registrationId) => {
      const registration = this.registrations.get(registrationId);
      return registration?.status === 'registered' && registration.memberIds.includes(userId);
    });
    if (!isAdmin && !participant) return null;
    return decrypt(match.roomIdCipher ?? Buffer.alloc(0), match.roomPasswordCipher ?? Buffer.alloc(0));
  }
}

interface Harness {
  readonly app: FastifyInstance;
  readonly auth: TestAuthRepository;
  readonly domain: MemoryCompetitionRepository;
  readonly admin: AuthUser;
  readonly user: AuthUser;
  readonly targets: readonly AuthUser[];
  readonly adminCookie: string;
  readonly userCookie: string;
}

function extractCookie(response: { headers: { 'set-cookie'?: unknown } }): string {
  const header = response.headers['set-cookie'];
  const text = Array.isArray(header) ? header[0] : header;
  if (typeof text !== 'string') throw new Error('Expected auth cookie.');
  return text.split(';', 1)[0] ?? '';
}

async function createHarness(context: TestContext): Promise<Harness> {
  const config: AppConfig = parseEnvironment({
    NODE_ENV: 'test', CORS_ORIGINS: TEST_ORIGIN, ROOM_CREDENTIALS_KEY: ROOM_KEY.toString('base64')
  });
  const auth = new TestAuthRepository();
  const domain = new MemoryCompetitionRepository();
  const admin = await auth.addTestUser('admin');
  const user = await auth.addTestUser('user');
  const targets = await Promise.all(Array.from({ length: 6 }, () => auth.addTestUser('user')));
  for (const account of [admin, user, ...targets]) await domain.addUser(account.userId, account.username);
  const app = buildApp(config, auth, domain);
  context.after(async () => app.close());
  const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { identifier: admin.email, password: TEST_PASSWORD } });
  const userLogin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { identifier: user.email, password: TEST_PASSWORD } });
  assert.equal(adminLogin.statusCode, 200);
  assert.equal(userLogin.statusCode, 200);
  return { app, auth, domain, admin, user, targets, adminCookie: extractCookie(adminLogin), userCookie: extractCookie(userLogin) };
}

function jsonHeaders(cookie?: string) {
  return { origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}) };
}

async function createTournament(harness: Harness, type: TournamentType = 'Solo') {
  const response = await harness.app.inject({
    method: 'POST', url: '/api/tournaments', headers: jsonHeaders(harness.adminCookie),
    payload: {
      name: `${type} Test Cup`, game: 'Free Fire', type, entryFee: 10, prizePool: 100,
      maxSlots: 8, startsAt: new Date(Date.now() + 86400000).toISOString(),
      registrationDeadline: new Date(Date.now() + 3600000).toISOString(), mode: 'Battle Royale'
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().tournament as TournamentView;
}

async function createTeam(harness: Harness) {
  const response = await harness.app.inject({
    method: 'POST', url: '/api/teams', headers: jsonHeaders(harness.userCookie),
    payload: { teamName: `Nightfall ${randomUUID().slice(0, 5)}`, teamTag: `N${randomUUID().slice(0, 4)}`.toUpperCase() }
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().team as TeamView;
}

async function addMember(harness: Harness, teamId: string, targetId: string, cookie = harness.userCookie) {
  return harness.app.inject({ method: 'POST', url: `/api/teams/${teamId}/members`, headers: jsonHeaders(cookie), payload: { userId: targetId } });
}

async function registerTournament(harness: Harness, tournamentId: string, cookie = harness.userCookie, teamId?: string) {
  return harness.app.inject({
    method: 'POST', url: `/api/tournaments/${tournamentId}/register`, headers: jsonHeaders(cookie),
    payload: teamId ? { teamId } : {}
  });
}

async function createMatch(harness: Harness, tournamentId: string, extra: Record<string, unknown> = {}) {
  return harness.app.inject({
    method: 'POST', url: '/api/matches', headers: jsonHeaders(harness.adminCookie),
    payload: {
      tournamentId, matchNumber: 1, title: 'Test match', game: 'Free Fire', mode: 'Battle Royale',
      startsAt: new Date(Date.now() + 86400000).toISOString(), maxPlayers: 8, ...extra
    }
  });
}

test('public tournament listing excludes drafts', async (context) => {
  const harness = await createHarness(context);
  const upcoming = harness.domain.seedTournament('Solo', 'upcoming');
  const draft = harness.domain.seedTournament('Squad', 'draft');
  const publicResponse = await harness.app.inject({ method: 'GET', url: '/api/tournaments' });
  const adminResponse = await harness.app.inject({ method: 'GET', url: '/api/tournaments', headers: { cookie: harness.adminCookie } });
  assert.equal(publicResponse.statusCode, 200);
  assert.equal(publicResponse.json().tournaments.some((item: TournamentView) => item.id === draft.id), false);
  assert.equal(publicResponse.json().tournaments.some((item: TournamentView) => item.id === upcoming.id), true);
  assert.equal(adminResponse.json().tournaments.some((item: TournamentView) => item.id === draft.id), true);
});

test('tournament details return a safe public record', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Duo');
  const response = await harness.app.inject({ method: 'GET', url: `/api/tournaments/${tournament.id}` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().tournament.type, 'Duo');
});

test('admin can create a tournament', async (context) => {
  const harness = await createHarness(context);
  const created = await createTournament(harness, 'Squad');
  assert.equal(created.type, 'Squad');
  assert.equal(created.status, 'upcoming');
});

test('tournament creation does not accept client-controlled status or ownership', async (context) => {
  const harness = await createHarness(context);
  const response = await harness.app.inject({
    method: 'POST', url: '/api/tournaments', headers: jsonHeaders(harness.adminCookie),
    payload: {
      name: 'Forged status', game: 'Free Fire', type: 'Solo', entryFee: 0, prizePool: 0, maxSlots: 4,
      startsAt: new Date(Date.now() + 86400000).toISOString(), registrationDeadline: new Date(Date.now() + 3600000).toISOString(),
      mode: 'Solo', status: 'completed', ownerId: harness.targets[0]!.userId
    }
  });
  assert.equal(response.statusCode, 400);
});

test('normal users cannot create tournaments', async (context) => {
  const harness = await createHarness(context);
  const response = await harness.app.inject({
    method: 'POST', url: '/api/tournaments', headers: jsonHeaders(harness.userCookie),
    payload: { name: 'Attempt', game: 'Free Fire', type: 'Solo', entryFee: 0, prizePool: 0, maxSlots: 8, startsAt: new Date().toISOString(), registrationDeadline: new Date().toISOString(), mode: 'Solo' }
  });
  assert.equal(response.statusCode, 403);
});

test('tournament updates require admin authorization', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament();
  const denied = await harness.app.inject({ method: 'PATCH', url: `/api/tournaments/${tournament.id}`, headers: jsonHeaders(harness.userCookie), payload: { name: 'Changed name' } });
  const updated = await harness.app.inject({ method: 'PATCH', url: `/api/tournaments/${tournament.id}`, headers: jsonHeaders(harness.adminCookie), payload: { name: 'Changed name' } });
  assert.equal(denied.statusCode, 403);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().tournament.name, 'Changed name');
});

test('tournament participation type cannot change after registration', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  await registerTournament(harness, tournament.id);
  const response = await harness.app.inject({ method: 'PATCH', url: `/api/tournaments/${tournament.id}`, headers: jsonHeaders(harness.adminCookie), payload: { type: 'Squad' } });
  assert.equal(response.statusCode, 409);
});

test('duplicate tournament registration reuses its existing entry without another debit', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  assert.equal((await registerTournament(harness, tournament.id)).statusCode, 201);
  const replay = await registerTournament(harness, tournament.id);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().registration.replayed, true);
});

test('tournament registration requires authentication', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament();
  const response = await harness.app.inject({
    method: 'POST', url: `/api/tournaments/${tournament.id}/register`, headers: { origin: TEST_ORIGIN }, payload: {}
  });
  assert.equal(response.statusCode, 401);
});

test('free tournament registration never mutates wallet state', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo', 'upcoming', 0);
  const response = await registerTournament(harness, tournament.id);
  assert.equal(response.statusCode, 201);
  assert.equal(harness.domain.walletWrites, 0);
});

test('paid registration debits the exact server fee once and returns the existing registration on retry', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo', 'upcoming', 7.25);
  harness.domain.walletBalances.set(harness.user.userId, 1000);
  const forged = await harness.app.inject({
    method: 'POST', url: `/api/tournaments/${tournament.id}/register`, headers: jsonHeaders(harness.userCookie),
    payload: { userId: harness.targets[0]!.userId, entryFee: 1, amountMinor: 1, status: 'paid' }
  });
  assert.equal(forged.statusCode, 400);

  const first = await registerTournament(harness, tournament.id);
  const replay = await registerTournament(harness, tournament.id);
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().registration.replayed, false);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().registration.replayed, true);
  assert.equal(replay.json().registration.registrationId, first.json().registration.registrationId);
  assert.equal(harness.domain.walletBalances.get(harness.user.userId), 275);
  assert.equal(harness.domain.walletWrites, 1);
});

test('paid registration rejects insufficient balance and rolls back a debit if registration creation fails', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo', 'upcoming', 10);
  harness.domain.walletBalances.set(harness.user.userId, 999);
  const insufficient = await registerTournament(harness, tournament.id);
  assert.equal(insufficient.statusCode, 409);
  assert.equal(insufficient.json().error.code, 'INSUFFICIENT_FUNDS');
  assert.equal(harness.domain.walletBalances.get(harness.user.userId), 999);
  assert.equal(harness.domain.registrations.size, 0);
  assert.equal(harness.domain.walletWrites, 0);

  harness.domain.walletBalances.set(harness.user.userId, 1500);
  harness.domain.failRegistrationAfterEntryDebit = true;
  const failed = await registerTournament(harness, tournament.id);
  assert.equal(failed.statusCode, 503);
  assert.equal(harness.domain.walletBalances.get(harness.user.userId), 1500);
  assert.equal(harness.domain.registrations.size, 0);
  assert.equal(harness.domain.walletWrites, 0);
});

test('concurrent paid-registration retries create one registration and one debit', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo', 'upcoming', 5);
  harness.domain.walletBalances.set(harness.user.userId, 1000);
  const results = await Promise.all([
    registerTournament(harness, tournament.id),
    registerTournament(harness, tournament.id)
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 201]);
  assert.equal(harness.domain.registrations.size, 1);
  assert.equal(harness.domain.walletBalances.get(harness.user.userId), 500);
  assert.equal(harness.domain.walletWrites, 1);
});

test('paid cancellation refunds the original payer once through a separate ledger operation', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo', 'upcoming', 5);
  harness.domain.walletBalances.set(harness.user.userId, 1000);
  const registration = await registerTournament(harness, tournament.id);
  assert.equal(registration.statusCode, 201);
  assert.equal(harness.domain.walletBalances.get(harness.user.userId), 500);

  const cancelled = await harness.app.inject({
    method: 'DELETE', url: `/api/tournaments/${tournament.id}/register`, headers: jsonHeaders(harness.userCookie)
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(harness.domain.walletBalances.get(harness.user.userId), 1000);
  assert.equal(harness.domain.walletWrites, 2);
  const repeated = await harness.app.inject({
    method: 'DELETE', url: `/api/tournaments/${tournament.id}/register`, headers: jsonHeaders(harness.userCookie)
  });
  assert.equal(repeated.statusCode, 404);
  assert.equal(harness.domain.walletBalances.get(harness.user.userId), 1000);
  assert.equal(harness.domain.walletWrites, 2);
});

test('Solo registration uses the authenticated player only', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  const response = await registerTournament(harness, tournament.id);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().registration.memberIds, [harness.user.userId]);
  const withTeam = await createTeam(harness);
  const wrongMode = await registerTournament(harness, tournament.id, harness.userCookie, withTeam.teamId);
  assert.equal(wrongMode.statusCode, 400);
});

test('Duo requires exactly two players and locks that roster after registration', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Duo');
  const team = await createTeam(harness);
  assert.equal((await registerTournament(harness, tournament.id, harness.userCookie, team.teamId)).statusCode, 400);
  assert.equal((await addMember(harness, team.teamId, harness.targets[0]!.userId)).statusCode, 201);
  assert.equal((await addMember(harness, team.teamId, harness.targets[1]!.userId)).statusCode, 201);
  assert.equal((await registerTournament(harness, tournament.id, harness.userCookie, team.teamId)).statusCode, 400);
  assert.equal((await harness.app.inject({ method: 'DELETE', url: `/api/teams/${team.teamId}/members/${harness.targets[1]!.userId}`, headers: jsonHeaders(harness.userCookie) })).statusCode, 200);
  const registration = await registerTournament(harness, tournament.id, harness.userCookie, team.teamId);
  assert.equal(registration.statusCode, 201);
  assert.equal(registration.json().registration.memberIds.length, 2);
  assert.equal((await addMember(harness, team.teamId, harness.targets[1]!.userId)).statusCode, 409);
});

test('Squad requires exactly four players and locks that roster after registration', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Squad');
  const team = await createTeam(harness);
  for (const target of harness.targets.slice(0, 3)) assert.equal((await addMember(harness, team.teamId, target!.userId)).statusCode, 201);
  assert.equal((await addMember(harness, team.teamId, harness.targets[3]!.userId)).statusCode, 201);
  assert.equal((await registerTournament(harness, tournament.id, harness.userCookie, team.teamId)).statusCode, 400);
  assert.equal((await harness.app.inject({ method: 'DELETE', url: `/api/teams/${team.teamId}/members/${harness.targets[3]!.userId}`, headers: jsonHeaders(harness.userCookie) })).statusCode, 200);
  const registration = await registerTournament(harness, tournament.id, harness.userCookie, team.teamId);
  assert.equal(registration.statusCode, 201);
  assert.equal(registration.json().registration.memberIds.length, 4);
  const remove = await harness.app.inject({ method: 'DELETE', url: `/api/teams/${team.teamId}/members/${harness.targets[0]!.userId}`, headers: jsonHeaders(harness.userCookie) });
  assert.equal(remove.statusCode, 409);
});

test('standalone teams are not assigned a universal four-member ceiling', async (context) => {
  const harness = await createHarness(context);
  const team = await createTeam(harness);
  for (const target of harness.targets.slice(0, 5)) assert.equal((await addMember(harness, team.teamId, target!.userId)).statusCode, 201);
  const response = await harness.app.inject({ method: 'GET', url: `/api/teams/${team.teamId}` });
  assert.equal(response.json().team.members.length, 6);
});

test('team creation and authenticated member addition work', async (context) => {
  const harness = await createHarness(context);
  const team = await createTeam(harness);
  const response = await addMember(harness, team.teamId, harness.targets[0]!.userId);
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().team.members.length, 2);
});

test('duplicate team membership is rejected', async (context) => {
  const harness = await createHarness(context);
  const team = await createTeam(harness);
  const userId = harness.targets[0]!.userId;
  assert.equal((await addMember(harness, team.teamId, userId)).statusCode, 201);
  assert.equal((await addMember(harness, team.teamId, userId)).statusCode, 409);
});

test('unauthorized users cannot modify or remove another team member', async (context) => {
  const harness = await createHarness(context);
  const team = await createTeam(harness);
  await addMember(harness, team.teamId, harness.targets[0]!.userId);
  const otherLogin = await harness.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { identifier: harness.targets[0]!.email, password: TEST_PASSWORD } });
  const otherCookie = extractCookie(otherLogin);
  const patch = await harness.app.inject({ method: 'PATCH', url: `/api/teams/${team.teamId}`, headers: jsonHeaders(otherCookie), payload: { description: 'takeover' } });
  const remove = await harness.app.inject({ method: 'DELETE', url: `/api/teams/${team.teamId}/members/${harness.user.userId}`, headers: jsonHeaders(otherCookie) });
  assert.equal(patch.statusCode, 403);
  assert.equal(remove.statusCode, 403);
});

test('team invitations require captain authorization and receiver response', async (context) => {
  const harness = await createHarness(context);
  const team = await createTeam(harness);
  const nonCaptainLogin = await harness.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { identifier: harness.targets[5]!.email, password: TEST_PASSWORD } });
  const denied = await harness.app.inject({ method: 'POST', url: `/api/teams/${team.teamId}/invitations`, headers: jsonHeaders(extractCookie(nonCaptainLogin)), payload: { receiverId: harness.targets[0]!.userId } });
  assert.equal(denied.statusCode, 403);
  const invited = await harness.app.inject({ method: 'POST', url: `/api/teams/${team.teamId}/invitations`, headers: jsonHeaders(harness.userCookie), payload: { receiverId: harness.targets[0]!.userId } });
  assert.equal(invited.statusCode, 201);
  const invitationId = invited.json().invitation.invitationId;
  const nonReceiver = await harness.app.inject({ method: 'PATCH', url: `/api/team-invitations/${invitationId}`, headers: jsonHeaders(harness.adminCookie), payload: { status: 'accepted' } });
  assert.equal(nonReceiver.statusCode, 403);
});

test('invitation acceptance applies the tournament roster constraint', async (context) => {
  const harness = await createHarness(context);
  const team = await createTeam(harness);
  const duo = harness.domain.seedTournament('Duo');
  await addMember(harness, team.teamId, harness.targets[0]!.userId);
  await registerTournament(harness, duo.id, harness.userCookie, team.teamId);
  const invited = await harness.app.inject({ method: 'POST', url: `/api/teams/${team.teamId}/invitations`, headers: jsonHeaders(harness.userCookie), payload: { receiverId: harness.targets[1]!.userId } });
  assert.equal(invited.statusCode, 201);
  const receiverLogin = await harness.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { identifier: harness.targets[1]!.email, password: TEST_PASSWORD } });
  const accept = await harness.app.inject({ method: 'PATCH', url: `/api/team-invitations/${invited.json().invitation.invitationId}`, headers: jsonHeaders(extractCookie(receiverLogin)), payload: { status: 'accepted' } });
  assert.equal(accept.statusCode, 409);
});

test('public match listing and details omit room credentials', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  const response = await createMatch(harness, tournament.id, { roomId: 'PRIVATE-ID', roomPassword: 'PRIVATE-PASSWORD', roomVisible: true });
  assert.equal(response.statusCode, 201);
  const match = response.json().match as MatchView;
  const list = await harness.app.inject({ method: 'GET', url: '/api/matches' });
  const detail = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}` });
  const adminList = await harness.app.inject({ method: 'GET', url: '/api/matches', headers: { cookie: harness.adminCookie } });
  const adminDetail = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}`, headers: { cookie: harness.adminCookie } });
  for (const result of [list.body, detail.body]) {
    assert.equal(result.includes('PRIVATE-ID'), false);
    assert.equal(result.includes('PRIVATE-PASSWORD'), false);
    assert.equal(result.includes('roomPassword'), false);
  }
  assert.equal(list.json().matches[0].roomVisible, undefined);
  assert.equal(detail.json().match.roomVisible, undefined);
  assert.equal(adminList.json().matches[0].roomVisible, true);
  assert.equal(adminDetail.json().match.roomVisible, true);
  assert.equal(response.json().match.roomVisible, true);
  assert.equal(list.statusCode, 200);
  assert.equal(detail.statusCode, 200);
});

test('admin can create a match; normal users cannot modify it', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament();
  const deniedCreate = await harness.app.inject({
    method: 'POST', url: '/api/matches', headers: jsonHeaders(harness.userCookie),
    payload: { tournamentId: tournament.id, matchNumber: 1, title: 'Denied', game: 'Free Fire', mode: 'BR', startsAt: new Date().toISOString(), maxPlayers: 8 }
  });
  const created = await createMatch(harness, tournament.id);
  const match = created.json().match as MatchView;
  assert.equal(created.statusCode, 201);
  assert.equal(deniedCreate.statusCode, 403);
  const denied = await harness.app.inject({ method: 'PATCH', url: `/api/matches/${match.matchId}`, headers: jsonHeaders(harness.userCookie), payload: { status: 'live' } });
  assert.equal(denied.statusCode, 403);
});

test('admin can view tournament and match registrations while other users cannot', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  const registration = await registerTournament(harness, tournament.id);
  const match = (await createMatch(harness, tournament.id)).json().match as MatchView;
  const tournamentRoster = await harness.app.inject({ method: 'GET', url: `/api/tournaments/${tournament.id}/registrations`, headers: { cookie: harness.adminCookie } });
  const matchRoster = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}/participants`, headers: { cookie: harness.adminCookie } });
  const deniedRoster = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}/participants`, headers: { cookie: harness.userCookie } });
  assert.equal(tournamentRoster.statusCode, 200);
  assert.equal(matchRoster.statusCode, 200);
  assert.equal(matchRoster.json().participants[0].registrationId, registration.json().registration.registrationId);
  assert.equal(matchRoster.json().participants[0].players[0].userId, harness.user.userId);
  assert.equal(deniedRoster.statusCode, 403);
});

test('protected room information requires an authenticated participant or admin', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  const registration = await registerTournament(harness, tournament.id);
  const matchResponse = await createMatch(harness, tournament.id, { roomId: 'ROOM-42', roomPassword: 'ROOM-SECRET', roomVisible: true });
  const match = matchResponse.json().match as MatchView;
  const publicRequest = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}/room-credentials` });
  const wrongUserLogin = await harness.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { identifier: harness.targets[0]!.email, password: TEST_PASSWORD } });
  const wrongUser = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}/room-credentials`, headers: { cookie: extractCookie(wrongUserLogin) } });
  const participant = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}/room-credentials`, headers: { cookie: harness.userCookie } });
  assert.equal(publicRequest.statusCode, 401);
  assert.equal(wrongUser.statusCode, 404);
  assert.equal(participant.statusCode, 200);
  assert.equal(participant.json().room.roomPassword, 'ROOM-SECRET');
  assert.equal(registration.statusCode, 201);
});

test('room publication notifies only registered participants and is idempotent', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  await registerTournament(harness, tournament.id, harness.userCookie);
  const otherRegistration = await registerTournament(harness, tournament.id, extractCookie(
    await harness.app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN },
      payload: { identifier: harness.targets[0]!.email, password: TEST_PASSWORD }
    })
  ));
  assert.equal(otherRegistration.statusCode, 201);
  const match = (await createMatch(harness, tournament.id)).json().match as MatchView;
  const beforeSave = await harness.app.inject({
    method: 'POST', url: `/api/matches/${match.matchId}/notify-room`, headers: jsonHeaders(harness.adminCookie), payload: {}
  });
  const unauthorizedNotify = await harness.app.inject({
    method: 'POST', url: `/api/matches/${match.matchId}/notify-room`, headers: jsonHeaders(harness.userCookie), payload: {}
  });
  assert.equal(beforeSave.statusCode, 409);
  assert.equal(unauthorizedNotify.statusCode, 403);
  const setCredentials = await harness.app.inject({
    method: 'PATCH', url: `/api/matches/${match.matchId}`, headers: jsonHeaders(harness.adminCookie),
    payload: { roomId: 'ROOM-42', roomPassword: 'ROOM-SECRET' }
  });
  assert.equal(setCredentials.statusCode, 200);
  const published = await harness.app.inject({
    method: 'POST', url: `/api/matches/${match.matchId}/notify-room`, headers: jsonHeaders(harness.adminCookie), payload: {}
  });
  const repeated = await harness.app.inject({
    method: 'POST', url: `/api/matches/${match.matchId}/notify-room`, headers: jsonHeaders(harness.adminCookie), payload: {}
  });
  const ownNotifications = await harness.app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: harness.userCookie } });
  const otherNotifications = await harness.app.inject({
    method: 'GET', url: '/api/notifications',
    headers: { cookie: extractCookie(await harness.app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN },
      payload: { identifier: harness.targets[0]!.email, password: TEST_PASSWORD }
    })) }
  });
  const unrelatedNotifications = await harness.app.inject({
    method: 'GET', url: '/api/notifications',
    headers: { cookie: extractCookie(await harness.app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN },
      payload: { identifier: harness.targets[1]!.email, password: TEST_PASSWORD }
    })) }
  });
  assert.equal(published.statusCode, 200);
  assert.equal(published.json().notified, 2);
  assert.equal(repeated.json().notified, 0);
  assert.equal(ownNotifications.json().notifications.length, 1);
  assert.equal(otherNotifications.json().notifications.length, 1);
  assert.equal(unrelatedNotifications.json().notifications.length, 0);
  assert.equal(JSON.stringify(ownNotifications.json()).includes('ROOM-SECRET'), false);
  const ownRoom = await harness.app.inject({
    method: 'GET', url: `/api/matches/${match.matchId}/room-credentials`, headers: { cookie: harness.userCookie }
  });
  assert.equal(ownRoom.statusCode, 200);
  assert.equal(ownRoom.json().room.roomPassword, 'ROOM-SECRET');
});

test('private matches are visible to their registered players and not unrelated accounts', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  await registerTournament(harness, tournament.id);
  const match = (await createMatch(harness, tournament.id, { visibility: 'private' })).json().match as MatchView;
  const participant = await harness.app.inject({
    method: 'GET', url: `/api/matches/${match.matchId}`, headers: { cookie: harness.userCookie }
  });
  const unrelatedLogin = await harness.app.inject({
    method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN },
    payload: { identifier: harness.targets[0]!.email, password: TEST_PASSWORD }
  });
  const unrelated = await harness.app.inject({
    method: 'GET', url: `/api/matches/${match.matchId}`, headers: { cookie: extractCookie(unrelatedLogin) }
  });
  assert.equal(participant.statusCode, 200);
  assert.equal(unrelated.statusCode, 404);
});

test('room credential decryption failures return a safe error without plaintext or key material', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  await registerTournament(harness, tournament.id);
  const matchResponse = await createMatch(harness, tournament.id, { roomId: 'PRIVATE-ROOM-ID', roomPassword: 'PRIVATE-ROOM-PASSWORD', roomVisible: true });
  const match = matchResponse.json().match as MatchView;
  const configWithoutKey = parseEnvironment({ NODE_ENV: 'test', CORS_ORIGINS: TEST_ORIGIN });
  const appWithoutKey = buildApp(configWithoutKey, harness.auth, harness.domain);
  context.after(async () => appWithoutKey.close());
  const response = await appWithoutKey.inject({
    method: 'GET',
    url: `/api/matches/${match.matchId}/room-credentials`,
    headers: { cookie: harness.userCookie }
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'ROOM_ENCRYPTION_UNAVAILABLE');
  assert.equal(response.body.includes('PRIVATE-ROOM-ID'), false);
  assert.equal(response.body.includes('PRIVATE-ROOM-PASSWORD'), false);
  assert.equal(response.body.includes('ROOM_CREDENTIALS_KEY'), false);
});

test('invalid room credential keys are rejected during configuration parsing', () => {
  assert.throws(
    () => parseEnvironment({ NODE_ENV: 'test', CORS_ORIGINS: TEST_ORIGIN, ROOM_CREDENTIALS_KEY: Buffer.alloc(31).toString('base64') }),
    /ROOM_CREDENTIALS_KEY must be a base64-encoded 32-byte key/
  );
});

test('unpublished match results are not visible publicly', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  await registerTournament(harness, tournament.id);
  const match = (await createMatch(harness, tournament.id)).json().match as MatchView;
  const denied = await harness.app.inject({
    method: 'POST', url: `/api/matches/${match.matchId}/result`, headers: jsonHeaders(harness.userCookie),
    payload: { status: 'published', playerId: harness.user.userId, placement: 1, points: 10, kills: 3 }
  });
  const submitted = await harness.app.inject({
    method: 'POST', url: `/api/matches/${match.matchId}/result`, headers: jsonHeaders(harness.adminCookie),
    payload: { status: 'submitted', playerId: harness.user.userId, placement: 1, points: 10, kills: 3 }
  });
  const publicRead = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}` });
  assert.equal(denied.statusCode, 403);
  assert.equal(submitted.statusCode, 200);
  assert.equal(publicRead.json().match.result, undefined);
});

test('published match results become public', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Solo');
  await registerTournament(harness, tournament.id);
  const secondParticipant = harness.targets[0]!;
  const secondLogin = await harness.app.inject({
    method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN },
    payload: { identifier: secondParticipant.email, password: TEST_PASSWORD }
  });
  await registerTournament(harness, tournament.id, extractCookie(secondLogin));
  const match = (await createMatch(harness, tournament.id)).json().match as MatchView;
  const publish = await harness.app.inject({
    method: 'POST', url: `/api/matches/${match.matchId}/result`, headers: jsonHeaders(harness.adminCookie),
    payload: {
      status: 'published',
      entries: [
        { playerId: harness.user.userId, placement: 1, points: 10, kills: 3 },
        { playerId: secondParticipant.userId, placement: 2, points: 7, kills: 2 }
      ]
    }
  });
  const publicRead = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}` });
  assert.equal(publish.statusCode, 200);
  assert.equal(publicRead.json().match.result.placement, 1);
  assert.equal(publicRead.json().match.result.points, 10);
  assert.equal(publicRead.json().match.result.winnerName, harness.user.username);
  assert.equal(publicRead.json().match.results.length, 2);
  assert.equal(publicRead.json().match.results[1].winnerName, secondParticipant.username);
});

test('private matches are hidden from the public and visible to admins', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament();
  const created = await createMatch(harness, tournament.id, { visibility: 'private' });
  const match = created.json().match as MatchView;
  const publicRead = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}` });
  const adminRead = await harness.app.inject({ method: 'GET', url: `/api/matches/${match.matchId}`, headers: { cookie: harness.adminCookie } });
  assert.equal(publicRead.statusCode, 404);
  assert.equal(adminRead.statusCode, 200);
});

test('client cannot assign itself admin role on team creation', async (context) => {
  const harness = await createHarness(context);
  const response = await harness.app.inject({
    method: 'POST', url: '/api/teams', headers: jsonHeaders(harness.userCookie),
    payload: { teamName: 'Safe team', teamTag: 'SAFE', role: 'admin', ownerId: harness.targets[0]!.userId, status: 'active' }
  });
  assert.equal(response.statusCode, 400);
});

test('malformed IDs and invalid request bodies are rejected', async (context) => {
  const harness = await createHarness(context);
  const malformedId = await harness.app.inject({ method: 'GET', url: '/api/tournaments/not-a-uuid' });
  const invalidTeam = await harness.app.inject({ method: 'POST', url: '/api/teams', headers: jsonHeaders(harness.userCookie), payload: { teamName: 'x', teamTag: 'BAD TAG' } });
  assert.equal(malformedId.statusCode, 400);
  assert.equal(invalidTeam.statusCode, 400);
});

test('non-members cannot register another user or team in a tournament', async (context) => {
  const harness = await createHarness(context);
  const tournament = harness.domain.seedTournament('Duo');
  const team = await createTeam(harness);
  await addMember(harness, team.teamId, harness.targets[0]!.userId);
  const anotherUserLogin = await harness.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { identifier: harness.targets[1]!.email, password: TEST_PASSWORD } });
  const unauthorized = await registerTournament(harness, tournament.id, extractCookie(anotherUserLogin), team.teamId);
  assert.equal(unauthorized.statusCode, 403);
});