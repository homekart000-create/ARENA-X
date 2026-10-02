export type TournamentType = 'Solo' | 'Duo' | 'Squad';
export type TournamentStatus = 'draft' | 'upcoming' | 'live' | 'completed' | 'cancelled';
export type TeamStatus = 'active' | 'closed' | 'suspended';
export type InvitationStatus = 'pending' | 'accepted' | 'declined';
export type MatchStatus = 'upcoming' | 'live' | 'completed' | 'cancelled';

export interface PrizeDistributionInput {
  readonly place: string;
  readonly percentage: number;
}

export interface TournamentInput {
  readonly name: string;
  readonly game: string;
  readonly type: TournamentType;
  readonly entryFee: number;
  readonly prizePool: number;
  readonly maxSlots: number;
  readonly startsAt: string;
  readonly registrationDeadline: string;
  readonly mode: string;
  readonly description?: string;
  readonly banner?: string;
  readonly map?: string;
  readonly host?: string;
  readonly rules?: readonly string[];
  readonly prizeDistribution?: readonly PrizeDistributionInput[];
  readonly featured?: boolean;
}

export type TournamentPatch = Partial<TournamentInput> & {
  readonly status?: TournamentStatus;
};

export interface TournamentView {
  readonly id: string;
  readonly name: string;
  readonly game: string;
  readonly type: TournamentType;
  readonly entryFee: number;
  readonly prizePool: number;
  readonly maxSlots: number;
  readonly joinedSlots: number;
  readonly startsAt: string;
  readonly registrationDeadline: string;
  readonly status: TournamentStatus;
  readonly mode: string;
  readonly description: string;
  readonly banner: string;
  readonly map: string;
  readonly host: string;
  readonly rules: readonly string[];
  readonly prizeDistribution: readonly PrizeDistributionInput[];
  readonly featured: boolean;
  readonly createdAt: string;
}

export interface RegistrationView {
  readonly registrationId: string;
  readonly tournamentId: string;
  readonly userId: string;
  readonly teamId: string | null;
  readonly memberIds: readonly string[];
  readonly registeredAt: string;
  readonly status: 'registered';
  readonly replayed?: boolean;
}

export interface TeamMemberView {
  readonly userId: string;
  readonly username: string;
  readonly fullName: string;
  readonly avatar: string | null;
  readonly role: 'CAPTAIN' | 'MEMBER';
  readonly joinedAt: string;
}

export interface TeamInput {
  readonly teamName: string;
  readonly teamTag: string;
  readonly logo?: string;
  readonly description?: string;
}

export type TeamPatch = Partial<TeamInput>;

export interface TeamView {
  readonly teamId: string;
  readonly teamName: string;
  readonly teamTag: string;
  readonly logo: string;
  readonly description: string;
  readonly ownerId: string;
  readonly status: TeamStatus;
  readonly createdAt: string;
  readonly members: readonly TeamMemberView[];
}

export interface InvitationView {
  readonly invitationId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly senderId: string;
  readonly receiverId: string;
  readonly createdAt: string;
  readonly status: InvitationStatus;
}

export interface MatchInput {
  readonly tournamentId: string;
  readonly matchNumber: number;
  readonly title: string;
  readonly game: string;
  readonly mode: string;
  readonly startsAt: string;
  readonly status?: MatchStatus;
  readonly map?: string;
  readonly instructions?: string;
  readonly maxPlayers: number;
  readonly registrationIds?: readonly string[];
  readonly visibility?: 'public' | 'private';
  readonly roomVisible?: boolean;
  readonly roomId?: string;
  readonly roomPassword?: string;
}

export type MatchPatch = Partial<Omit<MatchInput, 'tournamentId' | 'matchNumber'>>;

export interface EncryptedRoomPatch {
  readonly roomId?: Buffer | null;
  readonly roomPassword?: Buffer | null;
}

export interface MatchResultInput {
  readonly status: 'submitted' | 'published';
  readonly playerId?: string;
  readonly teamId?: string;
  readonly winnerName?: string;
  readonly placement: number;
  readonly points: number;
  readonly kills: number;
  readonly remarks?: string;
}

export interface MatchResultView {
  readonly winnerName: string;
  readonly placement: number;
  readonly points: number;
  readonly kills: number;
  readonly remarks: string;
}

export interface MatchView {
  readonly matchId: string;
  readonly tournamentId: string;
  readonly matchNumber: number;
  readonly title: string;
  readonly game: string;
  readonly mode: string;
  readonly startsAt: string;
  readonly status: MatchStatus;
  readonly map: string;
  readonly instructions: string;
  readonly maxPlayers: number;
  readonly visibility: 'public' | 'private';
  readonly roomVisible?: boolean;
  readonly participantCount: number;
  readonly result?: MatchResultView;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoomCredentials {
  readonly roomId: string;
  readonly roomPassword: string;
}

export interface CompetitionRepository {
  listTournaments(includePrivate: boolean): Promise<readonly TournamentView[]>;
  getTournament(id: string, includePrivate: boolean): Promise<TournamentView | null>;
  createTournament(ownerId: string, input: TournamentInput): Promise<TournamentView>;
  updateTournament(id: string, input: TournamentPatch): Promise<TournamentView | null>;
  registerForTournament(tournamentId: string, userId: string, teamId?: string): Promise<RegistrationView>;
  cancelTournamentRegistration(tournamentId: string, userId: string): Promise<boolean>;
  getTeam(id: string): Promise<TeamView | null>;
  createTeam(ownerId: string, input: TeamInput): Promise<TeamView>;
  updateTeam(id: string, actorId: string, input: TeamPatch, isAdmin: boolean): Promise<TeamView | null>;
  addTeamMember(id: string, actorId: string, userId: string, isAdmin: boolean): Promise<TeamView | null>;
  removeTeamMember(id: string, actorId: string, userId: string, isAdmin: boolean): Promise<TeamView | null>;
  createInvitation(id: string, actorId: string, receiverId: string, isAdmin: boolean): Promise<InvitationView>;
  respondToInvitation(id: string, actorId: string, status: 'accepted' | 'declined'): Promise<InvitationView | null>;
  listMatches(includePrivate: boolean): Promise<readonly MatchView[]>;
  getMatch(id: string, includePrivate: boolean): Promise<MatchView | null>;
  createMatch(ownerId: string, input: MatchInput, roomId: Buffer | null, roomPassword: Buffer | null): Promise<MatchView>;
  updateMatch(id: string, input: MatchPatch, credentials: EncryptedRoomPatch): Promise<MatchView | null>;
  setMatchResult(id: string, submittedByUserId: string, input: MatchResultInput): Promise<MatchView | null>;
  getRoomCredentials(id: string, userId: string, isAdmin: boolean, decrypt: (id: Buffer, password: Buffer) => RoomCredentials): Promise<RoomCredentials | null>;
}

export class CompetitionError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'CompetitionError';
  }
}