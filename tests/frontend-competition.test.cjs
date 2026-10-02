const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'js/api.js'), 'utf8');
const competitionSource = fs.readFileSync(path.join(root, 'js/competition-api.js'), 'utf8');
const tournamentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const teamId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const matchId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const receiverId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const backendTournament = (overrides = {}) => ({
  id: tournamentId,
  name: 'ARENA API Cup',
  game: 'Free Fire',
  type: 'Duo',
  entryFee: 49,
  prizePool: 15000,
  maxSlots: 48,
  joinedSlots: 3,
  startsAt: '2026-10-04T14:00:00.000Z',
  registrationDeadline: '2026-10-04T13:00:00.000Z',
  status: 'upcoming',
  mode: 'Battle Royale',
  description: 'Backend tournament',
  banner: 'night',
  map: 'Bermuda',
  host: 'ARENA X',
  rules: [],
  prizeDistribution: [],
  featured: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...overrides
});

const backendTeam = (overrides = {}) => ({
  teamId,
  teamName: 'API Team',
  teamTag: 'API',
  logo: 'AX',
  description: '',
  ownerId: userId,
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  members: [{ userId, username: 'captain', fullName: 'Captain', avatar: 'CA', role: 'CAPTAIN', joinedAt: '2026-09-01T00:00:00.000Z' }],
  ...overrides
});

const backendMatch = (overrides = {}) => ({
  matchId,
  tournamentId,
  matchNumber: 1,
  title: 'API Match',
  game: 'Free Fire',
  mode: 'Battle Royale',
  startsAt: '2026-10-04T14:00:00.000Z',
  status: 'upcoming',
  map: 'Bermuda',
  instructions: '',
  maxPlayers: 48,
  visibility: 'public',
  participantCount: 2,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides
});

function createCompetitionHarness(handler, options = {}) {
  const calls = [];
  const localWrites = [];
  const localValues = new Map(Object.entries(options.localStorage || {}));
  const sessionValues = new Map();
  const storage = {
    getItem(key) { return localValues.has(key) ? localValues.get(key) : null; },
    setItem(key, value) { localWrites.push([key, String(value)]); localValues.set(key, String(value)); },
    removeItem(key) { localValues.delete(key); }
  };
  const sessionStorage = {
    getItem(key) { return sessionValues.has(key) ? sessionValues.get(key) : null; },
    setItem(key, value) { sessionValues.set(key, String(value)); },
    removeItem(key) { sessionValues.delete(key); }
  };
  const auth = {
    ready: Promise.resolve(),
    getCurrentUser: () => ({ userId, username: 'captain', fullName: 'Captain', teamId: options.teamHint || null }),
    isAdmin: () => options.isAdmin === true,
    findUserByUsername: (name) => name.toLowerCase() === 'receiver' ? { userId: receiverId, username: 'receiver' } : null
  };
  const api = {
    async request(url, requestOptions = {}) {
      const call = { url, options: requestOptions };
      calls.push(call);
      return handler(call);
    }
  };
  const sandbox = { ArenaApi: api, ArenaAuth: auth, localStorage: storage, sessionStorage };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(competitionSource, sandbox, { filename: 'js/competition-api.js' });
  return {
    stores: { tournaments: sandbox.ArenaTournaments, teams: sandbox.ArenaTeams, matches: sandbox.ArenaMatches },
    calls,
    localWrites,
    localValues,
    sessionValues
  };
}

function body(call) { return JSON.parse(JSON.stringify(call.options.body)); }

async function baseHandler({ url, options }) {
  if (url === '/api/tournaments' && options.method === 'POST') return { tournament: backendTournament() };
  if (url === '/api/tournaments') return { tournaments: [backendTournament()] };
  if (url === `/api/tournaments/${tournamentId}`) return { tournament: backendTournament() };
  if (url === '/api/matches' && options.method === 'POST') return { match: backendMatch() };
  if (url === '/api/matches') return { matches: [backendMatch()] };
  if (url === `/api/matches/${matchId}`) return { match: backendMatch() };
  if (url === `/api/teams/${teamId}`) return { team: backendTeam() };
  if (url === '/api/teams' && options.method === 'POST') return { team: backendTeam() };
  if (url === `/api/teams/${teamId}` && options.method === 'PATCH') return { team: backendTeam() };
  if (url === `/api/teams/${teamId}/members` && options.method === 'POST') return { team: backendTeam() };
  if (url === `/api/teams/${teamId}/members/${receiverId}` && options.method === 'DELETE') return { team: backendTeam() };
  if (url === `/api/teams/${teamId}/invitations`) return { invitation: { invitationId: 'invite-1', teamId, receiverId, status: 'pending' } };
  if (url === '/api/team-invitations/invite-1') return { invitation: { invitationId: 'invite-1', teamId, receiverId, status: body({ options }).status } };
  if (url === `/api/tournaments/${tournamentId}/register` && options.method === 'POST') {
    return { registration: { registrationId: 'registration-1', tournamentId, userId, teamId: null, memberIds: [userId], registeredAt: '2026-10-01T00:00:00.000Z', status: 'registered' } };
  }
  if (url === `/api/tournaments/${tournamentId}/register` && options.method === 'DELETE') return { success: true };
  if (url === `/api/matches/${matchId}` && options.method === 'PATCH') return { match: backendMatch() };
  if (url === `/api/matches/${matchId}/result`) return { match: backendMatch({ result: { winnerName: 'API Team', placement: 1, points: 10, kills: 4, remarks: '' } }) };
  if (url === `/api/matches/${matchId}/room-credentials`) return { room: { roomId: 'ROOM-1', roomPassword: 'SECRET-1' } };
  throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
}

async function ready(stores) {
  await Promise.all([stores.tournaments.ready, stores.teams.ready, stores.matches.ready]);
}

test('tournament list and detail load from backend and normalize the API date contract', async () => {
  const harness = createCompetitionHarness(baseHandler);
  await ready(harness.stores);
  const listed = harness.stores.tournaments.getTournaments();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, tournamentId);
  assert.equal(listed[0].status, 'Upcoming');
  assert.equal(listed[0].startDate, '2026-10-04');
  assert.match(listed[0].startTime, /IST$/);
  const detail = await harness.stores.tournaments.loadTournament(tournamentId);
  assert.equal(detail.name, 'ARENA API Cup');
  assert.equal(harness.calls.some((call) => call.url === '/api/tournaments'), true);
  assert.equal(harness.calls.some((call) => call.url === `/api/tournaments/${tournamentId}`), true);
});

test('tournament create and update use only Step 20 fields', async () => {
  const harness = createCompetitionHarness(baseHandler);
  await ready(harness.stores);
  const created = await harness.stores.tournaments.createTournament({
    name: 'ARENA API Cup', game: 'Free Fire', type: 'Duo', entryFee: 49, prizePool: 15000,
    maxSlots: 48, startsAt: backendTournament().startsAt, registrationDeadline: backendTournament().registrationDeadline,
    mode: 'Battle Royale', ownerId: userId, status: 'Draft', role: 'admin'
  });
  assert.equal(created.success, true);
  const create = harness.calls.find((call) => call.url === '/api/tournaments' && call.options.method === 'POST');
  assert.equal(Object.hasOwn(body(create), 'ownerId'), false);
  assert.equal(Object.hasOwn(body(create), 'role'), false);
  assert.equal(Object.hasOwn(body(create), 'status'), false);
  const updated = await harness.stores.tournaments.updateTournament(tournamentId, { status: 'Live' });
  assert.equal(updated.success, true);
  const update = harness.calls.find((call) => call.url === `/api/tournaments/${tournamentId}` && call.options.method === 'PATCH');
  assert.deepEqual(body(update), { status: 'live' });
});

test('tournament registration and cancellation use authenticated API routes without client identity', async () => {
  const harness = createCompetitionHarness(baseHandler);
  await ready(harness.stores);
  const joined = await harness.stores.tournaments.joinTournament(tournamentId, { teamId });
  assert.equal(joined.success, true);
  const post = harness.calls.find((call) => call.url === `/api/tournaments/${tournamentId}/register` && call.options.method === 'POST');
  assert.deepEqual(body(post), { teamId });
  assert.equal(Object.hasOwn(body(post), 'userId'), false);
  const cancelled = await harness.stores.tournaments.cancelRegistration(tournamentId);
  assert.equal(cancelled.success, true);
  assert.equal(harness.calls.some((call) => call.url === `/api/tournaments/${tournamentId}/register` && call.options.method === 'DELETE'), true);
});

test('team create, detail, update, member changes, and invitation responses use backend contracts', async () => {
  const harness = createCompetitionHarness(baseHandler, { teamHint: teamId });
  await ready(harness.stores);
  const teams = harness.stores.teams;
  const team = await teams.loadTeam(teamId);
  assert.equal(team.ownerId, userId);
  const created = await teams.createTeam({ teamName: 'API Team', teamTag: 'api', logo: 'AX', description: '' });
  assert.equal(created.success, true);
  const createCall = harness.calls.find((call) => call.url === '/api/teams' && call.options.method === 'POST');
  assert.equal(body(createCall).teamTag, 'API');
  assert.equal(Object.hasOwn(body(createCall), 'ownerId'), false);
  assert.equal((await teams.updateTeam(teamId, { teamName: 'Updated API Team' })).success, true);
  assert.equal((await teams.addTeamMember(teamId, receiverId)).success, true);
  assert.equal((await teams.removeTeamMember(teamId, receiverId)).success, true);
  assert.equal((await teams.sendTeamInvitation(teamId, 'receiver')).success, true);
  assert.equal((await teams.acceptTeamInvitation('invite-1')).success, true);
  assert.ok(harness.calls.some((call) => call.url === `/api/teams/${teamId}` && call.options.method === 'PATCH'));
  assert.ok(harness.calls.some((call) => call.url === `/api/teams/${teamId}/members` && call.options.method === 'POST'));
  assert.ok(harness.calls.some((call) => call.url === `/api/teams/${teamId}/members/${receiverId}` && call.options.method === 'DELETE'));
  assert.ok(harness.calls.some((call) => call.url === `/api/teams/${teamId}/invitations` && call.options.method === 'POST'));
  assert.ok(harness.calls.some((call) => call.url === '/api/team-invitations/invite-1' && call.options.method === 'PATCH'));
  assert.equal(teams.areInvitationListsAvailable(), false);
  assert.equal((await teams.transferCaptain(teamId, receiverId)).reason, 'UNSUPPORTED');
});

test('match list and detail use public backend projections', async () => {
  const harness = createCompetitionHarness(baseHandler);
  await ready(harness.stores);
  assert.equal(harness.stores.matches.getMatches()[0].participantCount, 2);
  assert.equal(harness.stores.matches.getMatches()[0].roomPassword, '');
  assert.equal(harness.stores.matches.getMatches()[0].roomVisible, false);
  const detail = await harness.stores.matches.loadMatch(matchId);
  assert.equal(detail.title, 'API Match');
  assert.ok(harness.calls.some((call) => call.url === '/api/matches'));
  assert.ok(harness.calls.some((call) => call.url === `/api/matches/${matchId}`));
});

test('admin match projections preserve room visibility without exposing credentials', async () => {
  const harness = createCompetitionHarness(async (call) => {
    if (call.url === '/api/matches') return { matches: [backendMatch({ roomVisible: true })] };
    return baseHandler(call);
  }, { isAdmin: true });
  await ready(harness.stores);
  const match = harness.stores.matches.getMatches()[0];
  assert.equal(harness.stores.matches.isOrganizer(), true);
  assert.equal(match.roomVisible, true);
  assert.equal(match.roomId, '');
  assert.equal(match.roomPassword, '');
});

test('match updates convert form capacity and dates to the Step 20 patch contract', async () => {
  const harness = createCompetitionHarness(baseHandler);
  await ready(harness.stores);
  const result = await harness.stores.matches.updateMatch(matchId, {
    date: '2026-10-04', startTime: '7:30 PM IST', maxPlayers: '16', status: 'live', roomId: '', roomPassword: '', roomVisible: true
  });
  assert.equal(result.success, true);
  const patch = harness.calls.find((call) => call.url === `/api/matches/${matchId}` && call.options.method === 'PATCH');
  assert.equal(typeof body(patch).maxPlayers, 'number');
  assert.equal(body(patch).status, 'live');
  assert.match(body(patch).startsAt, /2026-10-04T14:00:00/);
  assert.equal(Object.hasOwn(body(patch), 'roomPassword'), false);
  assert.equal(body(patch).roomVisible, true);
  const matchPageSource = fs.readFileSync(path.join(root, 'js/match-pages.js'), 'utf8');
  assert.match(matchPageSource, /name="roomVisible" type="checkbox" \$\{match\.roomVisible \? 'checked' : ''\}/);
  assert.match(matchPageSource, /roomVisible: formData\.has\('roomVisible'\)/);
});

test('admin tournament/match writes are attempted through backend authorization, never local role data', async () => {
  const harness = createCompetitionHarness(async (call) => {
    if (call.url === '/api/tournaments') return { tournaments: [backendTournament()] };
    if (call.url === `/api/tournaments/${tournamentId}` && call.options.method === 'PATCH') {
      throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN', status: 403, message: 'You are not allowed to perform this action.' });
    }
    if (call.url === '/api/matches' && call.options.method === 'POST') {
      throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN', status: 403, message: 'You are not allowed to perform this action.' });
    }
    if (call.url === '/api/matches') return { matches: [backendMatch()] };
    throw new Error(`Unexpected request ${call.url}`);
  }, {
    localStorage: {
      'arenaX_tournaments': JSON.stringify([{ id: tournamentId, role: 'admin' }]),
      'arenaX_teams': JSON.stringify([{ teamId, ownerId: userId, role: 'captain' }]),
      'arenaX_matches': JSON.stringify([{ matchId, roomPassword: 'legacy-secret' }])
    }
  });
  await ready(harness.stores);
  assert.equal(harness.stores.tournaments.getTournaments()[0].name, 'ARENA API Cup');
  assert.equal(harness.stores.teams.getTeamById(teamId), null);
  assert.equal(harness.stores.matches.getMatchById(matchId).roomPassword, '');
  const deniedTournament = await harness.stores.tournaments.updateTournament(tournamentId, { status: 'live' });
  const deniedMatch = await harness.stores.matches.createMatch({ tournamentId, matchNumber: 1, title: 'X', game: 'X', mode: 'X', date: '2026-10-04', startTime: '7:00 PM IST', maxPlayers: 1 });
  assert.equal(deniedTournament.reason, 'FORBIDDEN');
  assert.equal(deniedMatch.reason, 'FORBIDDEN');
  assert.equal(harness.localWrites.length, 0);
});

test('match results and protected room credentials use their dedicated endpoints without local persistence', async () => {
  const harness = createCompetitionHarness(baseHandler);
  await ready(harness.stores);
  const result = await harness.stores.matches.submitMatchResult(matchId, { status: 'published', teamId, placement: 1, points: 10, kills: 4 });
  assert.equal(result.success, true);
  const resultCall = harness.calls.find((call) => call.url === `/api/matches/${matchId}/result`);
  assert.equal(body(resultCall).teamId, teamId);
  assert.equal(Object.hasOwn(body(resultCall), 'userId'), false);
  const room = await harness.stores.matches.getRoomCredentials(matchId);
  assert.equal(room.roomPassword, 'SECRET-1');
  assert.equal(harness.calls.some((call) => call.url === `/api/matches/${matchId}/room-credentials`), true);
  assert.equal(harness.localWrites.length, 0);
  assert.equal([...harness.localValues.values()].join(' '), '');
});

test('backend failure clears migrated caches rather than falling back to local demo records', async () => {
  const harness = createCompetitionHarness(async () => {
    throw Object.assign(new Error('network'), { code: 'NETWORK', message: 'Could not reach the backend.' });
  }, {
    localStorage: {
      'arenaX_tournaments': JSON.stringify([backendTournament()]),
      'arenaX_teams': JSON.stringify([backendTeam()]),
      'arenaX_matches': JSON.stringify([backendMatch()])
    }
  });
  await ready(harness.stores);
  assert.equal(harness.stores.tournaments.getTournaments().length, 0);
  assert.equal(harness.stores.matches.getMatches().length, 0);
  assert.match(harness.stores.tournaments.getError().message, /backend/);
  assert.equal(harness.localWrites.length, 0);
});

test('API maps competition errors safely and classifies a static host 404 as backend unavailable', async () => {
  const sandbox = {
    document: { baseURI: 'https://example.test/ARENA-X/index.html' },
    URL,
    Headers,
    async fetch(url) {
      if (url.endsWith('/register')) {
        return { ok: false, status: 409, text: async () => JSON.stringify({ error: { code: 'TOURNAMENT_FULL', message: 'raw server detail' } }) };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(apiSource, sandbox);
  await assert.rejects(sandbox.ArenaApi.request('/api/tournaments/id/register', { method: 'POST', body: {} }), (error) => {
    assert.equal(error.code, 'TOURNAMENT_FULL');
    assert.equal(error.message, 'This tournament is full.');
    return true;
  });
  await assert.rejects(sandbox.ArenaApi.request('/api/matches'), (error) => {
    assert.equal(error.code, 'BACKEND_UNAVAILABLE');
    return true;
  });
});

test('migrated pages load the API stores in order; PWA and notification page remain intact', () => {
  const migratedPages = ['admin.html', 'index.html', 'leaderboard.html', 'match.html', 'matches.html', 'my-team.html', 'my-tournaments.html', 'profile.html', 'team.html', 'tournament.html', 'tournaments.html'];
  for (const page of migratedPages) {
    const markup = fs.readFileSync(path.join(root, page), 'utf8');
    assert.ok(markup.indexOf('js/api.js') < markup.indexOf('js/auth.js'), `${page} loads API after auth`);
    assert.ok(markup.indexOf('js/auth.js') < markup.indexOf('js/competition-api.js'), `${page} loads stores before auth`);
    assert.ok(markup.indexOf('js/competition-api.js') < markup.indexOf('js/tournaments.js'), `${page} loads the backend store after legacy modules`);
    assert.match(markup, /js\/pwa\.js/);
  }
  const notifications = fs.readFileSync(path.join(root, 'notifications.html'), 'utf8');
  assert.doesNotMatch(notifications, /js\/competition-api\.js/);
  assert.match(notifications, /js\/notifications\.js/);
  assert.match(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8'), /addEventListener\('fetch'/);
});
