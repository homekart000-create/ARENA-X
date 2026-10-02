import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { requireAdmin } from '../auth/middleware.js';
import type {
  CompetitionRepository,
  MatchInput,
  MatchPatch,
  MatchResultInput,
  TeamInput,
  TeamPatch,
  TournamentInput,
  TournamentPatch
} from './contracts.js';
import { CompetitionError } from './contracts.js';
import { decryptRoomValues, encryptRoomValue } from '../utils/room-credentials.js';

const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: uuidPattern } }
} as const;

interface IdParams {
  id: string;
}

interface TeamMemberParams extends IdParams {
  userId: string;
}

interface TeamMemberBody {
  userId: string;
}

interface InvitationBody {
  receiverId: string;
}

interface InvitationPatchBody {
  status: 'accepted' | 'declined';
}

interface TournamentRegistrationBody {
  teamId?: string;
}

interface CompetitionRouteOptions {
  readonly config: AppConfig;
  readonly repository: CompetitionRepository;
  readonly requireAuth: preHandlerHookHandler;
  readonly optionalAuth: preHandlerHookHandler;
}

function originAllowed(config: AppConfig, origin: string | undefined): boolean {
  return origin !== undefined && config.corsOrigins.includes(origin);
}

function forbidden(reply: Parameters<preHandlerHookHandler>[1]) {
  return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
}

function safeRoomEncryption(action: () => Buffer | null): Buffer | null {
  try {
    return action();
  } catch {
    throw new CompetitionError(503, 'ROOM_ENCRYPTION_UNAVAILABLE', 'Room credential storage is not configured.');
  }
}

const tournamentInputProperties = {
  name: { type: 'string', minLength: 2, maxLength: 120 },
  game: { type: 'string', minLength: 2, maxLength: 60 },
  type: { type: 'string', enum: ['Solo', 'Duo', 'Squad'] },
  entryFee: { type: 'number', minimum: 0, maximum: 1000000 },
  prizePool: { type: 'number', minimum: 0, maximum: 1000000000 },
  maxSlots: { type: 'integer', minimum: 1, maximum: 100000 },
  startsAt: { type: 'string', format: 'date-time' },
  registrationDeadline: { type: 'string', format: 'date-time' },
  mode: { type: 'string', minLength: 1, maxLength: 100 },
  description: { type: 'string', maxLength: 5000 },
  banner: { type: 'string', maxLength: 80 },
  map: { type: 'string', maxLength: 80 },
  host: { type: 'string', maxLength: 120 },
  rules: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 1000 } },
  prizeDistribution: {
    type: 'array', maxItems: 50,
    items: {
      type: 'object', additionalProperties: false, required: ['place', 'percentage'],
      properties: { place: { type: 'string', minLength: 1, maxLength: 60 }, percentage: { type: 'number', minimum: 0, maximum: 100 } }
    }
  },
  featured: { type: 'boolean' },
  status: { type: 'string', enum: ['draft', 'upcoming', 'live', 'completed', 'cancelled'] }
};

const tournamentCreateSchema = {
  type: 'object', additionalProperties: false,
  required: ['name', 'game', 'type', 'entryFee', 'prizePool', 'maxSlots', 'startsAt', 'registrationDeadline', 'mode'],
  properties: Object.fromEntries(Object.entries(tournamentInputProperties).filter(([property]) => property !== 'status'))
};

const tournamentPatchSchema = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: tournamentInputProperties
};

const teamInputProperties = {
  teamName: { type: 'string', minLength: 3, maxLength: 32 },
  teamTag: { type: 'string', minLength: 2, maxLength: 6, pattern: '^[A-Za-z0-9]+$' },
  logo: { type: 'string', maxLength: 80 },
  description: { type: 'string', maxLength: 240 }
};

const teamCreateSchema = {
  type: 'object', additionalProperties: false, required: ['teamName', 'teamTag'], properties: teamInputProperties
};

const teamPatchSchema = {
  type: 'object', additionalProperties: false, minProperties: 1, properties: teamInputProperties
};

const matchInputProperties = {
  tournamentId: { type: 'string', pattern: uuidPattern },
  matchNumber: { type: 'integer', minimum: 1 },
  title: { type: 'string', minLength: 1, maxLength: 80 },
  game: { type: 'string', minLength: 1, maxLength: 60 },
  mode: { type: 'string', minLength: 1, maxLength: 80 },
  startsAt: { type: 'string', format: 'date-time' },
  status: { type: 'string', enum: ['upcoming', 'live', 'completed', 'cancelled'] },
  map: { type: 'string', maxLength: 80 },
  instructions: { type: 'string', maxLength: 1000 },
  maxPlayers: { type: 'integer', minimum: 1, maximum: 100000 },
  registrationIds: { type: 'array', maxItems: 100000, uniqueItems: true, items: { type: 'string', pattern: uuidPattern } },
  visibility: { type: 'string', enum: ['public', 'private'] },
  roomVisible: { type: 'boolean' },
  roomId: { type: 'string', maxLength: 80 },
  roomPassword: { type: 'string', maxLength: 80 }
};

const matchPatchProperties = {
  title: matchInputProperties.title,
  game: matchInputProperties.game,
  mode: matchInputProperties.mode,
  startsAt: matchInputProperties.startsAt,
  status: matchInputProperties.status,
  map: matchInputProperties.map,
  instructions: matchInputProperties.instructions,
  maxPlayers: matchInputProperties.maxPlayers,
  registrationIds: matchInputProperties.registrationIds,
  visibility: matchInputProperties.visibility,
  roomVisible: matchInputProperties.roomVisible,
  roomId: matchInputProperties.roomId,
  roomPassword: matchInputProperties.roomPassword
};

export function registerCompetitionRoutes(app: FastifyInstance, options: CompetitionRouteOptions): void {
  const { config, repository, requireAuth, optionalAuth } = options;

  app.get('/api/tournaments', { preHandler: optionalAuth }, async (request) => ({
    tournaments: await repository.listTournaments(request.authUser?.role === 'admin')
  }));

  app.get<{ Params: IdParams }>('/api/tournaments/:id', {
    preHandler: optionalAuth,
    schema: { params: idParamsSchema }
  }, async (request, reply) => {
    const tournament = await repository.getTournament(request.params.id, request.authUser?.role === 'admin');
    if (!tournament) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Tournament not found.' } });
    return { tournament };
  });

  app.post<{ Body: TournamentInput }>('/api/tournaments', {
    preHandler: [requireAuth, requireAdmin],
    schema: { body: tournamentCreateSchema }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const tournament = await repository.createTournament(request.authUser!.userId, request.body);
    return reply.code(201).send({ tournament });
  });

  app.patch<{ Params: IdParams; Body: TournamentPatch }>('/api/tournaments/:id', {
    preHandler: [requireAuth, requireAdmin],
    schema: { params: idParamsSchema, body: tournamentPatchSchema }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const tournament = await repository.updateTournament(request.params.id, request.body);
    if (!tournament) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Tournament not found.' } });
    return { tournament };
  });

  app.post<{ Params: IdParams; Body: TournamentRegistrationBody }>('/api/tournaments/:id/register', {
    preHandler: requireAuth,
    schema: {
      params: idParamsSchema,
      body: { type: 'object', additionalProperties: false, properties: { teamId: { type: 'string', pattern: uuidPattern } } }
    }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const registration = await repository.registerForTournament(request.params.id, request.authUser!.userId, request.body.teamId);
    return reply.code(registration.replayed ? 200 : 201).send({ registration });
  });

  app.delete<{ Params: IdParams }>('/api/tournaments/:id/register', {
    preHandler: requireAuth,
    schema: { params: idParamsSchema }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const cancelled = await repository.cancelTournamentRegistration(request.params.id, request.authUser!.userId);
    if (!cancelled) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Registration not found.' } });
    return { success: true };
  });

  app.get<{ Params: IdParams }>('/api/teams/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const team = await repository.getTeam(request.params.id);
    if (!team) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Team not found.' } });
    return { team };
  });

  app.post<{ Body: TeamInput }>('/api/teams', {
    preHandler: requireAuth,
    schema: { body: teamCreateSchema }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const teamInput = request.body;
    const team = await repository.createTeam(request.authUser!.userId, { ...teamInput, teamTag: teamInput.teamTag.toUpperCase() });
    return reply.code(201).send({ team });
  });

  app.patch<{ Params: IdParams; Body: TeamPatch }>('/api/teams/:id', {
    preHandler: requireAuth,
    schema: { params: idParamsSchema, body: teamPatchSchema }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const teamInput = request.body;
    const team = await repository.updateTeam(request.params.id, request.authUser!.userId, {
      ...teamInput,
      ...(teamInput.teamTag !== undefined ? { teamTag: teamInput.teamTag.toUpperCase() } : {})
    }, request.authUser!.role === 'admin');
    if (!team) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Team not found.' } });
    return { team };
  });

  app.post<{ Params: IdParams; Body: TeamMemberBody }>('/api/teams/:id/members', {
    preHandler: requireAuth,
    schema: {
      params: idParamsSchema,
      body: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', pattern: uuidPattern } } }
    }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const team = await repository.addTeamMember(request.params.id, request.authUser!.userId, request.body.userId, request.authUser!.role === 'admin');
    if (!team) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Team not found.' } });
    return reply.code(201).send({ team });
  });

  app.delete<{ Params: TeamMemberParams }>('/api/teams/:id/members/:userId', {
    preHandler: requireAuth,
    schema: { params: { type: 'object', additionalProperties: false, required: ['id', 'userId'], properties: { id: { type: 'string', pattern: uuidPattern }, userId: { type: 'string', pattern: uuidPattern } } } }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const team = await repository.removeTeamMember(request.params.id, request.authUser!.userId, request.params.userId, request.authUser!.role === 'admin');
    if (!team) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Team not found.' } });
    return { team };
  });

  app.post<{ Params: IdParams; Body: InvitationBody }>('/api/teams/:id/invitations', {
    preHandler: requireAuth,
    schema: {
      params: idParamsSchema,
      body: { type: 'object', additionalProperties: false, required: ['receiverId'], properties: { receiverId: { type: 'string', pattern: uuidPattern } } }
    }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const invitation = await repository.createInvitation(request.params.id, request.authUser!.userId, request.body.receiverId, request.authUser!.role === 'admin');
    return reply.code(201).send({ invitation });
  });

  app.patch<{ Params: IdParams; Body: InvitationPatchBody }>('/api/team-invitations/:id', {
    preHandler: requireAuth,
    schema: {
      params: idParamsSchema,
      body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['accepted', 'declined'] } } }
    }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const invitation = await repository.respondToInvitation(request.params.id, request.authUser!.userId, request.body.status);
    if (!invitation) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Invitation not found.' } });
    return { invitation };
  });

  app.get('/api/matches', { preHandler: optionalAuth }, async (request) => ({
    matches: await repository.listMatches(request.authUser?.role === 'admin')
  }));

  app.get<{ Params: IdParams }>('/api/matches/:id', {
    preHandler: optionalAuth,
    schema: { params: idParamsSchema }
  }, async (request, reply) => {
    const match = await repository.getMatch(request.params.id, request.authUser?.role === 'admin');
    if (!match) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Match not found.' } });
    return { match };
  });

  app.post<{ Body: MatchInput }>('/api/matches', {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['tournamentId', 'matchNumber', 'title', 'game', 'mode', 'startsAt', 'maxPlayers'],
        properties: matchInputProperties
      }
    }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const input = request.body;
    const match = await repository.createMatch(
      request.authUser!.userId,
      input,
      safeRoomEncryption(() => encryptRoomValue(input.roomId, config.roomCredentialsKey)),
      safeRoomEncryption(() => encryptRoomValue(input.roomPassword, config.roomCredentialsKey))
    );
    return reply.code(201).send({ match });
  });

  app.patch<{ Params: IdParams; Body: MatchPatch }>('/api/matches/:id', {
    preHandler: [requireAuth, requireAdmin],
    schema: { params: idParamsSchema, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: matchPatchProperties } }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const body = request.body;
    const credentials = {
      ...(body.roomId !== undefined ? { roomId: safeRoomEncryption(() => encryptRoomValue(body.roomId, config.roomCredentialsKey)) } : {}),
      ...(body.roomPassword !== undefined ? { roomPassword: safeRoomEncryption(() => encryptRoomValue(body.roomPassword, config.roomCredentialsKey)) } : {})
    };
    const match = await repository.updateMatch(request.params.id, body, credentials);
    if (!match) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Match not found.' } });
    return { match };
  });

  app.post<{ Params: IdParams; Body: MatchResultInput }>('/api/matches/:id/result', {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      params: idParamsSchema,
      body: {
        type: 'object', additionalProperties: false,
        required: ['status', 'placement', 'points', 'kills'],
        properties: {
          status: { type: 'string', enum: ['submitted', 'published'] },
          playerId: { type: 'string', pattern: uuidPattern },
          teamId: { type: 'string', pattern: uuidPattern },
          winnerName: { type: 'string', maxLength: 120 },
          placement: { type: 'integer', minimum: 0 },
          points: { type: 'integer', minimum: 0 },
          kills: { type: 'integer', minimum: 0 },
          remarks: { type: 'string', maxLength: 500 }
        },
        anyOf: [{ required: ['playerId'] }, { required: ['teamId'] }],
        not: { required: ['playerId', 'teamId'] }
      }
    }
  }, async (request, reply) => {
    if (!originAllowed(config, request.headers.origin)) return forbidden(reply);
    const match = await repository.setMatchResult(request.params.id, request.authUser!.userId, request.body);
    if (!match) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Match not found.' } });
    return { match };
  });

  app.get<{ Params: IdParams }>('/api/matches/:id/room-credentials', {
    preHandler: requireAuth,
    schema: { params: idParamsSchema }
  }, async (request, reply) => {
    const room = await repository.getRoomCredentials(
      request.params.id,
      request.authUser!.userId,
      request.authUser!.role === 'admin',
      (encryptedId, encryptedPassword) => {
        try {
          return decryptRoomValues(encryptedId, encryptedPassword, config.roomCredentialsKey);
        } catch {
          throw new CompetitionError(503, 'ROOM_ENCRYPTION_UNAVAILABLE', 'Room credential storage is not configured.');
        }
      }
    );
    if (!room) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Room credentials are not available.' } });
    return { room };
  });
}