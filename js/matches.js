(() => {
  if (globalThis.ArenaCompetitionBackend) return;
  const MATCHES_KEY = 'arenaX_matches';
  const matchStatuses = new Set(['upcoming', 'live', 'completed', 'cancelled']);
  const resultStatuses = new Set(['pending', 'submitted', 'published']);

  function seedMatches() {
    const timestamp = new Date().toISOString();
    return [
      { matchId: 'match-s08-live-01', tournamentId: 'arena-x-rookie-rush', matchNumber: 1, title: 'Survivor Series #12', game: 'Free Fire', mode: 'Battle Royale / Duo', date: '2026-09-29', startTime: '7:00 PM IST', status: 'live', map: 'Bermuda', roomId: 'AX-ROOKIE-204', roomPassword: 'S08DROP', roomVisible: false, maxPlayers: 48, registeredPlayers: [], registeredTeams: [], resultStatus: 'pending', instructions: 'Sample match. Follow organizer instructions in the tournament lobby.', homeFeatured: true, homeDisplay: { event: 'SURVIVOR SERIES #12', first: 'NOVA', second: 'RAVEN', score: '12 : 09', detail: 'Round 3 / Bermuda' }, createdAt: timestamp, updatedAt: timestamp },
      { matchId: 'match-s08-live-02', tournamentId: 'arena-x-rookie-rush', matchNumber: 2, title: 'Rookie Rumble', game: 'Free Fire', mode: 'Battle Royale / Duo', date: '2026-09-29', startTime: '7:30 PM IST', status: 'live', map: 'Purgatory', roomId: '', roomPassword: '', roomVisible: false, maxPlayers: 48, registeredPlayers: [], registeredTeams: [], resultStatus: 'pending', instructions: 'Sample match. Follow organizer instructions in the tournament lobby.', homeFeatured: true, homeDisplay: { event: 'ROOKIE RUMBLE', first: 'VORTEX', second: 'ONYX', score: '08 : 08', detail: 'Round 2 / Purgatory' }, createdAt: timestamp, updatedAt: timestamp },
      { matchId: 'match-s08-upcoming-01', tournamentId: 'arena-x-free-fire-clash', matchNumber: 1, title: 'Drop Zone Showdown', game: 'Free Fire', mode: 'Battle Royale / Squad', date: '2026-10-04', startTime: '7:30 PM IST', status: 'upcoming', map: 'Bermuda', roomId: '', roomPassword: '', roomVisible: false, maxPlayers: 100, registeredPlayers: [], registeredTeams: [], resultStatus: 'pending', instructions: 'Room details will be available before the match starts.', homeFeatured: true, homeDisplay: { event: 'DROP ZONE SHOWDOWN', first: 'TBD', second: 'TBD', score: 'OCT 04', detail: 'Squad / Registration open' }, createdAt: timestamp, updatedAt: timestamp },
      { matchId: 'match-s08-completed-01', tournamentId: 'arena-x-classic-series', matchNumber: 1, title: 'Classic Series Final', game: 'Free Fire', mode: 'Battle Royale / Solo', date: '2026-09-20', startTime: '6:00 PM IST', status: 'completed', map: 'Purgatory', roomId: 'AX-CLASSIC-100', roomPassword: 'FINALE', roomVisible: false, maxPlayers: 64, registeredPlayers: [], registeredTeams: [], resultStatus: 'published', instructions: 'Sample result from a completed demo fixture.', results: [{ teamId: null, playerId: null, winnerName: 'ShadowX', placement: 1, points: 20, kills: 8, remarks: 'Sample result' }], createdAt: timestamp, updatedAt: timestamp }
    ];
  }

  function readStoredMatches() {
    try {
      const saved = localStorage.getItem(MATCHES_KEY);
      if (saved === null) {
        const seeded = seedMatches();
        localStorage.setItem(MATCHES_KEY, JSON.stringify(seeded));
        return seeded;
      }
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed) ? parsed.filter(isValidMatch).map(normalizeMatch) : [];
    } catch {
      return [];
    }
  }

  function saveMatches(matches) {
    if (!Array.isArray(matches) || !matches.every(isPersistableMatch)) return false;
    try {
      const existing = localStorage.getItem(MATCHES_KEY);
      if (existing !== null) {
        const parsed = JSON.parse(existing);
        if (!Array.isArray(parsed) || !parsed.every(isPersistableMatch)) return false;
      }
      localStorage.setItem(MATCHES_KEY, JSON.stringify(matches));
      return true;
    } catch {
      return false;
    }
  }

  function getTournamentStore() {
    return globalThis.ArenaTournaments;
  }

  function getTeamStore() {
    return globalThis.ArenaTeams;
  }

  function isValidResult(result) {
    return Boolean(result && typeof result === 'object' && !Array.isArray(result)
      && (result.teamId === null || result.teamId === undefined || typeof result.teamId === 'string')
      && (result.playerId === null || result.playerId === undefined || typeof result.playerId === 'string')
      && (result.winnerName === undefined || typeof result.winnerName === 'string')
      && ['placement', 'points', 'kills'].every((field) => result[field] === undefined
        || (Number.isFinite(Number(result[field])) && Number(result[field]) >= 0))
      && (result.remarks === undefined || typeof result.remarks === 'string'));
  }

  function isValidMatch(match) {
    if (!match || typeof match !== 'object' || Array.isArray(match)) return false;
    if (typeof match.matchId !== 'string' || !match.matchId.trim()
      || typeof match.tournamentId !== 'string' || !match.tournamentId.trim()
      || !Number.isInteger(match.matchNumber) || match.matchNumber < 1
      || !['title', 'game', 'mode', 'startTime'].every((field) => typeof match[field] === 'string')
      || !matchStatuses.has(match.status)) return false;
    if (match.date !== undefined && match.date !== ''
      && (!/^\d{4}-\d{2}-\d{2}$/.test(match.date) || Number.isNaN(Date.parse(`${match.date}T12:00:00`)))) return false;
    if (match.maxPlayers !== undefined && (!Number.isInteger(match.maxPlayers) || match.maxPlayers < 1)) return false;
    if (match.roomId !== undefined && typeof match.roomId !== 'string') return false;
    if (match.roomPassword !== undefined && typeof match.roomPassword !== 'string') return false;
    if (match.roomVisible !== undefined && typeof match.roomVisible !== 'boolean') return false;
    if (match.resultStatus !== undefined && !resultStatuses.has(match.resultStatus)) return false;
    if (match.results !== undefined && !Array.isArray(match.results)) return false;
    if (match.participantRegistrationIds !== undefined && match.participantRegistrationIds !== null
      && (!Array.isArray(match.participantRegistrationIds) || !match.participantRegistrationIds.every((id) => typeof id === 'string'))) return false;
    return true;
  }

  function isPersistableMatch(match) {
    return isValidMatch(match) && (!Array.isArray(match.results) || match.results.every(isValidResult));
  }

  function normalizeMatch(match) {
    return {
      ...match,
      date: typeof match.date === 'string' ? match.date : '',
      maxPlayers: Number.isInteger(match.maxPlayers) && match.maxPlayers > 0 ? match.maxPlayers : 1,
      roomId: typeof match.roomId === 'string' ? match.roomId : '',
      roomPassword: typeof match.roomPassword === 'string' ? match.roomPassword : '',
      roomVisible: match.roomVisible === true,
      resultStatus: resultStatuses.has(match.resultStatus) ? match.resultStatus : 'pending',
      results: Array.isArray(match.results) ? match.results.filter(isValidResult).map((result) => ({ ...result })) : [],
      participantRegistrationIds: Array.isArray(match.participantRegistrationIds) ? [...match.participantRegistrationIds] : null,
      registeredPlayers: Array.isArray(match.registeredPlayers) ? match.registeredPlayers.filter((id) => typeof id === 'string') : [],
      registeredTeams: Array.isArray(match.registeredTeams) ? match.registeredTeams.filter((id) => typeof id === 'string') : [],
      homeDisplay: match.homeDisplay && typeof match.homeDisplay === 'object' && !Array.isArray(match.homeDisplay)
        ? { ...match.homeDisplay }
        : null
    };
  }

  function publicMatch(match) {
    const normalized = normalizeMatch(match);
    const homeDisplay = {};
    ['event', 'first', 'second', 'score', 'detail'].forEach((field) => {
      if (typeof normalized.homeDisplay?.[field] === 'string') homeDisplay[field] = normalized.homeDisplay[field];
    });
    return {
      matchId: normalized.matchId,
      tournamentId: normalized.tournamentId,
      matchNumber: normalized.matchNumber,
      title: normalized.title,
      game: normalized.game,
      mode: normalized.mode,
      date: normalized.date,
      startTime: normalized.startTime,
      status: normalized.status,
      map: normalized.map,
      maxPlayers: normalized.maxPlayers,
      roomVisible: normalized.roomVisible,
      participantRegistrationIds: normalized.participantRegistrationIds,
      resultStatus: normalized.resultStatus,
      results: normalized.resultStatus === 'published' ? normalized.results.map((result) => ({ ...result })) : [],
      instructions: typeof normalized.instructions === 'string' ? normalized.instructions : '',
      homeFeatured: normalized.homeFeatured === true,
      homeDisplay,
      createdAt: typeof normalized.createdAt === 'string' ? normalized.createdAt : '',
      updatedAt: typeof normalized.updatedAt === 'string' ? normalized.updatedAt : ''
    };
  }

  function findStoredMatchById(matchId) {
    return readStoredMatches().find((match) => match.matchId === matchId) || null;
  }

  function isOrganizer() {
    return Boolean(globalThis.ArenaAuth?.isAdmin?.());
  }

  function organizerError() {
    return { success: false, reason: 'organizer', message: 'Log in with the ARENA X demo account to manage sample matches.' };
  }

  function registrationsForMatch(match) {
    const registrations = getTournamentStore()?.getParticipants?.() || [];
    const selectedIds = Array.isArray(match.participantRegistrationIds) ? new Set(match.participantRegistrationIds) : null;
    return registrations.filter((registration) => registration.tournamentId === match.tournamentId
      && String(registration.status || 'registered').toLowerCase() !== 'cancelled'
      && (!selectedIds || selectedIds.has(registration.registrationId)));
  }

  function participantIds(registrations) {
    const playerIds = new Set();
    const teamIds = new Set();
    registrations.forEach((registration) => {
      playerIds.add(registration.userId);
      (registration.memberIds || []).forEach((userId) => playerIds.add(userId));
      if (registration.teamId) teamIds.add(registration.teamId);
    });
    return { registeredPlayers: [...playerIds], registeredTeams: [...teamIds] };
  }

  function getMatchParticipants(matchOrId) {
    const match = typeof matchOrId === 'string' ? findStoredMatchById(matchOrId) : matchOrId;
    if (!match) return { registrations: [], players: [], teams: [] };
    const registrations = registrationsForMatch(match);
    const ids = participantIds(registrations);
    const players = ids.registeredPlayers.map((userId) => globalThis.ArenaAuth?.getUserById?.(userId)).filter(Boolean);
    const teams = ids.registeredTeams.map((teamId) => getTeamStore()?.getTeamById?.(teamId)).filter(Boolean);
    return { registrations, players, teams };
  }

  function getMatches() {
    return readStoredMatches().map(publicMatch);
  }

  function getMatchById(matchId) {
    if (typeof matchId !== 'string') return null;
    const match = findStoredMatchById(matchId);
    return match ? publicMatch(match) : null;
  }

  function getMatchesByTournament(tournamentId) {
    return readStoredMatches().filter((match) => match.tournamentId === tournamentId).map(publicMatch);
  }

  function getMyMatches(userId = globalThis.ArenaAuth?.getCurrentUser()?.userId) {
    if (!userId) return [];
    return readStoredMatches().filter((match) => registrationsForMatch(match).some((registration) => registration.userId === userId || registration.memberIds?.includes(userId))).map(publicMatch);
  }

  function getAdminMatches() {
    if (!isOrganizer()) return [];
    return readStoredMatches().map((match) => ({ ...normalizeMatch(match) }));
  }

  function getAdminMatchById(matchId) {
    if (!isOrganizer() || typeof matchId !== 'string') return null;
    const match = findStoredMatchById(matchId);
    return match ? normalizeMatch(match) : null;
  }

  function getRoomCredentials(matchId) {
    const user = globalThis.ArenaAuth?.getCurrentUser?.();
    const match = typeof matchId === 'string' ? findStoredMatchById(matchId) : null;
    if (!user || !match || !match.roomVisible || !['upcoming', 'live'].includes(match.status)) return null;
    const isParticipant = registrationsForMatch(match).some((registration) => registration.userId === user.userId
      || registration.memberIds?.includes(user.userId));
    if (!isOrganizer() && !isParticipant) return null;
    return { roomId: match.roomId, roomPassword: match.roomPassword };
  }

  function createId() {
    return globalThis.crypto?.randomUUID?.() || `match-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function createMatch(details) {
    if (!isOrganizer()) return organizerError();
    const tournament = getTournamentStore()?.getTournamentById(details.tournamentId);
    if (!tournament) return { success: false, reason: 'tournament', message: 'Choose an existing tournament.' };
    if (!String(details.matchNumber || '').trim() || !String(details.title || '').trim() || !String(details.game || '').trim() || !String(details.mode || '').trim() || !details.date || !String(details.startTime || '').trim()) {
      return { success: false, reason: 'required', message: 'Tournament, match number, title, game, mode, date, and start time are required.' };
    }
    const matchNumber = Number(details.matchNumber);
    const maxPlayers = Number(details.maxPlayers);
    if (!Number.isInteger(matchNumber) || matchNumber < 1) return { success: false, reason: 'match-number', message: 'Match number must be a positive whole number.' };
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1) return { success: false, reason: 'max-players', message: 'Maximum players or teams must be at least 1.' };
    const matches = readStoredMatches();
    if (matches.some((match) => match.matchNumber === matchNumber && match.tournamentId === tournament.id)) {
      return { success: false, reason: 'duplicate-number', message: 'That match number is already used in this tournament.' };
    }
    const matchId = createId();
    if (matches.some((match) => match.matchId === matchId)) return { success: false, reason: 'duplicate-id', message: 'A match with that ID already exists.' };
    const participants = registrationsForMatch({ tournamentId: tournament.id });
    const match = {
      matchId,
      tournamentId: tournament.id,
      matchNumber,
      title: String(details.title).trim().slice(0, 80),
      game: String(details.game).trim().slice(0, 60),
      mode: String(details.mode).trim().slice(0, 80),
      date: details.date,
      startTime: String(details.startTime).trim().slice(0, 40),
      status: 'upcoming',
      map: String(details.map || '').trim().slice(0, 60),
      roomId: String(details.roomId || '').trim().slice(0, 80),
      roomPassword: String(details.roomPassword || '').trim().slice(0, 80),
      roomVisible: false,
      maxPlayers,
      ...participantIds(participants),
      participantRegistrationIds: null,
      instructions: String(details.instructions || '').trim().slice(0, 1000),
      resultStatus: 'pending',
      results: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!saveMatches([...matches, match])) return { success: false, reason: 'storage', message: 'Your browser could not save this match.' };
    return { success: true, match: publicMatch(match) };
  }

  function updateMatch(matchId, updates) {
    if (!isOrganizer()) return organizerError();
    const matches = readStoredMatches();
    const index = matches.findIndex((match) => match.matchId === matchId);
    if (index < 0) return { success: false, reason: 'missing', message: 'Match not found.' };
    const current = matches[index];
    const status = updates.status ?? current.status;
    if (!matchStatuses.has(status)) return { success: false, reason: 'status', message: 'Choose a valid match status.' };
    const resultStatus = updates.resultStatus ?? current.resultStatus ?? 'pending';
    if (!resultStatuses.has(resultStatus)) return { success: false, reason: 'result-status', message: 'Choose a valid result status.' };
    const maxPlayers = updates.maxPlayers === undefined ? current.maxPlayers : Number(updates.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1) return { success: false, reason: 'max-players', message: 'Maximum players or teams must be at least 1.' };
    let selectedRegistrationIds = current.participantRegistrationIds;
    let participantFields = {};
    if (Array.isArray(updates.participantRegistrationIds)) {
      const validRegistrations = registrationsForMatch({ tournamentId: current.tournamentId });
      const validIds = new Set(validRegistrations.map((registration) => registration.registrationId));
      selectedRegistrationIds = [...new Set(updates.participantRegistrationIds)].filter((id) => validIds.has(id));
      participantFields = { participantRegistrationIds: selectedRegistrationIds, ...participantIds(validRegistrations.filter((registration) => selectedRegistrationIds.includes(registration.registrationId))) };
    }
    const result = updates.result || current.results?.[0] || {};
    const winnerId = String(updates.winnerId ?? result.teamId ?? result.playerId ?? '').trim();
    const participants = getMatchParticipants({ ...current, ...participantFields, participantRegistrationIds: selectedRegistrationIds });
    const winnerTeam = participants.teams.find((team) => team.teamId === winnerId);
    const winnerPlayer = participants.players.find((player) => player.userId === winnerId);
    const winnerName = updates.winnerName ?? winnerTeam?.teamName ?? winnerPlayer?.username ?? result.winnerName ?? '';
    const placement = Number(updates.placement ?? result.placement ?? 0);
    const points = Number(updates.points ?? result.points ?? 0);
    const kills = Number(updates.kills ?? result.kills ?? 0);
    if (![placement, points, kills].every((value) => Number.isFinite(value) && value >= 0)) return { success: false, reason: 'result', message: 'Placement, points, and kills must be zero or greater.' };
    const nextResult = winnerName || winnerId || placement || points || kills || updates.remarks
      ? [{ teamId: winnerTeam?.teamId || null, playerId: winnerPlayer?.userId || null, winnerName, placement, points, kills, remarks: String(updates.remarks ?? result.remarks ?? '').trim().slice(0, 500) }]
      : [];
    const updated = {
      ...current,
      ...participantFields,
      date: updates.date === undefined ? current.date : String(updates.date),
      startTime: updates.startTime === undefined ? current.startTime : String(updates.startTime).trim().slice(0, 40),
      map: updates.map === undefined ? current.map : String(updates.map).trim().slice(0, 60),
      status,
      roomId: updates.roomId === undefined ? current.roomId : String(updates.roomId).trim().slice(0, 80),
      roomPassword: updates.roomPassword === undefined ? current.roomPassword : String(updates.roomPassword).trim().slice(0, 80),
      roomVisible: updates.roomVisible === undefined ? current.roomVisible : Boolean(updates.roomVisible),
      instructions: updates.instructions === undefined ? current.instructions : String(updates.instructions).trim().slice(0, 1000),
      maxPlayers,
      resultStatus,
      results: nextResult,
      updatedAt: new Date().toISOString()
    };
    matches[index] = updated;
    if (!saveMatches(matches)) return { success: false, reason: 'storage', message: 'Your browser could not save this update.' };
    return { success: true, match: publicMatch(updated) };
  }

  globalThis.ArenaMatches = Object.freeze({
    getMatches,
    getMatchById,
    getMatchesByTournament,
    getMyMatches,
    getMatchParticipants,
    getAdminMatches,
    getAdminMatchById,
    getRoomCredentials,
    createMatch,
    updateMatch,
    isOrganizer
  });
})();