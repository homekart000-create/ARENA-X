import { CompetitionError, type CompetitionRepository } from './contracts.js';
import type {
  EncryptedRoomPatch,
  InvitationView,
  MatchInput,
  MatchPatch,
  MatchResultInput,
  MatchView,
  RegistrationView,
  RoomCredentials,
  TeamInput,
  TeamPatch,
  TeamView,
  TournamentInput,
  TournamentPatch,
  TournamentView
} from './contracts.js';

function unavailable(): never {
  throw new CompetitionError(503, 'SERVICE_UNAVAILABLE', 'Competition storage is temporarily unavailable.');
}

export class UnavailableCompetitionRepository implements CompetitionRepository {
  async listTournaments(_includePrivate: boolean): Promise<readonly TournamentView[]> { return unavailable(); }
  async getTournament(_id: string, _includePrivate: boolean): Promise<TournamentView | null> { return unavailable(); }
  async createTournament(_ownerId: string, _input: TournamentInput): Promise<TournamentView> { return unavailable(); }
  async updateTournament(_id: string, _input: TournamentPatch): Promise<TournamentView | null> { return unavailable(); }
  async registerForTournament(_tournamentId: string, _userId: string, _teamId?: string): Promise<RegistrationView> { return unavailable(); }
  async cancelTournamentRegistration(_tournamentId: string, _userId: string): Promise<boolean> { return unavailable(); }
  async getTeam(_id: string): Promise<TeamView | null> { return unavailable(); }
  async createTeam(_ownerId: string, _input: TeamInput): Promise<TeamView> { return unavailable(); }
  async updateTeam(_id: string, _actorId: string, _input: TeamPatch, _isAdmin: boolean): Promise<TeamView | null> { return unavailable(); }
  async addTeamMember(_id: string, _actorId: string, _userId: string, _isAdmin: boolean): Promise<TeamView | null> { return unavailable(); }
  async removeTeamMember(_id: string, _actorId: string, _userId: string, _isAdmin: boolean): Promise<TeamView | null> { return unavailable(); }
  async createInvitation(_id: string, _actorId: string, _receiverId: string, _isAdmin: boolean): Promise<InvitationView> { return unavailable(); }
  async respondToInvitation(_id: string, _actorId: string, _status: 'accepted' | 'declined'): Promise<InvitationView | null> { return unavailable(); }
  async listMatches(_includePrivate: boolean): Promise<readonly MatchView[]> { return unavailable(); }
  async getMatch(_id: string, _includePrivate: boolean): Promise<MatchView | null> { return unavailable(); }
  async createMatch(_ownerId: string, _input: MatchInput, _roomId: Buffer | null, _roomPassword: Buffer | null): Promise<MatchView> { return unavailable(); }
  async updateMatch(_id: string, _input: MatchPatch, _credentials: EncryptedRoomPatch): Promise<MatchView | null> { return unavailable(); }
  async setMatchResult(_id: string, _submittedByUserId: string, _input: MatchResultInput): Promise<MatchView | null> { return unavailable(); }
  async getRoomCredentials(_id: string, _userId: string, _isAdmin: boolean, _decrypt: (roomId: Buffer, password: Buffer) => RoomCredentials): Promise<RoomCredentials | null> { return unavailable(); }
}