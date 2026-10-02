(() => {
  const api = globalThis.ArenaApi;
  const auth = globalThis.ArenaAuth;
  const tournamentCache = new Map();
  const teamCache = new Map();
  const matchCache = new Map();
  const sessionRegistrations = new Map();
  let tournamentsError = null;
  let teamsError = null;
  let matchesError = null;
  let tournamentsLoaded = false;
  let matchesLoaded = false;
  let userTeamLookupError = null;
  const statusNames = { upcoming: 'Upcoming', live: 'Live', completed: 'Completed', cancelled: 'Cancelled', draft: 'Draft' };

  function dateParts(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return { startDate: '', startTime: '' };
    const calendar = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata' })
      .formatToParts(date).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
    return {
      startDate: `${calendar.year}-${calendar.month}-${calendar.day}`,
      startTime: `${new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(date)} IST`
    };
  }

  function isoFromLocalFields(date, time) {
    if (!date || !time) return undefined;
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*IST)?$/i.exec(String(time).trim());
    if (!match) return new Date(`${date}T${time}`).toISOString();
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === 'PM') hour += 12;
    return new Date(`${date}T${String(hour).padStart(2, '0')}:${match[2]}:00+05:30`).toISOString();
  }

  function tournamentFromApi(value) {
    const startsAt = dateParts(value.startsAt);
    const status = statusNames[value.status] || value.status;
    return {
      ...value,
      status,
      startDate: startsAt.startDate,
      startTime: startsAt.startTime,
      entryFee: Number(value.entryFee),
      prizePool: Number(value.prizePool),
      joinedSlots: Number(value.joinedSlots),
      maxSlots: Number(value.maxSlots),
      rules: Array.isArray(value.rules) ? [...value.rules] : [],
      prizeDistribution: Array.isArray(value.prizeDistribution) ? value.prizeDistribution.map((prize) => ({ ...prize })) : []
    };
  }

  function matchFromApi(value) {
    const when = dateParts(value.startsAt);
    const result = value.result ? { ...value.result, teamId: null, playerId: null } : null;
    return {
      ...value,
      date: when.startDate,
      startTime: when.startTime,
      maxPlayers: Number(value.maxPlayers),
      roomVisible: value.roomVisible === true,
      resultStatus: result ? 'published' : 'pending',
      results: result ? [result] : [],
      roomId: '',
      roomPassword: '',
      participantRegistrationIds: null,
      registeredPlayers: [],
      registeredTeams: [],
      homeFeatured: false,
      homeDisplay: null
    };
  }

  function cacheTournament(value) {
    const tournament = tournamentFromApi(value);
    tournamentCache.set(tournament.id, tournament);
    return tournament;
  }

  function cacheTeam(value) {
    if (!value || typeof value.teamId !== 'string' || !Array.isArray(value.members)) throw new Error('The backend returned an invalid team record.');
    const team = { ...value, members: value.members.map((member) => ({ ...member })) };
    teamCache.set(team.teamId, team);
    return team;
  }

  function cacheMatch(value) {
    const match = matchFromApi(value);
    matchCache.set(match.matchId, match);
    return match;
  }

  async function loadTournaments() {
    try {
      const response = await api.request('/api/tournaments');
      if (!Array.isArray(response.tournaments)) throw new Error('The backend returned an invalid tournament list.');
      tournamentCache.clear();
      response.tournaments.forEach(cacheTournament);
      tournamentsError = null;
    } catch (error) {
      tournamentsError = error;
      tournamentCache.clear();
    }
    tournamentsLoaded = true;
    return getTournaments();
  }

  async function loadTournament(id) {
    if (typeof id !== 'string' || !id) return null;
    try {
      const response = await api.request(`/api/tournaments/${encodeURIComponent(id)}`);
      if (!response.tournament) throw new Error('The backend returned an invalid tournament record.');
      tournamentsError = null;
      return cacheTournament(response.tournament);
    } catch (error) {
      tournamentsError = error;
      throw error;
    }
  }

  function toTournamentInput(input) {
    const fields = ['name', 'game', 'type', 'entryFee', 'prizePool', 'maxSlots', 'mode', 'description', 'banner', 'map', 'host', 'rules', 'prizeDistribution', 'featured'];
    const body = Object.fromEntries(fields.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
    const startsAt = input.startsAt || (input.startDate && input.startTime ? isoFromLocalFields(input.startDate, input.startTime) : undefined);
    if (startsAt) body.startsAt = startsAt;
    if (input.registrationDeadline !== undefined) body.registrationDeadline = input.registrationDeadline;
    if (input.status) body.status = String(input.status).toLowerCase();
    return body;
  }

  async function createTournament(input) {
    try {
      const body = toTournamentInput(input);
      delete body.status;
      const response = await api.request('/api/tournaments', { method: 'POST', body });
      return { success: true, tournament: cacheTournament(response.tournament) };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function updateTournament(id, input) {
    try {
      const response = await api.request(`/api/tournaments/${encodeURIComponent(id)}`, { method: 'PATCH', body: toTournamentInput(input) });
      return { success: true, tournament: cacheTournament(response.tournament) };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  function getTournaments() {
    return [...tournamentCache.values()];
  }

  function getTournamentById(id) {
    return tournamentCache.get(id) || null;
  }

  function getAvailableSlots(tournamentOrId) {
    const tournament = typeof tournamentOrId === 'string' ? getTournamentById(tournamentOrId) : tournamentOrId;
    return tournament ? Math.max(0, tournament.maxSlots - tournament.joinedSlots) : 0;
  }

  function currentUserId() {
    return auth?.getCurrentUser()?.userId || null;
  }

  function currentRegistration(tournamentId, userId = currentUserId()) {
    if (!userId) return null;
    return sessionRegistrations.get(`${tournamentId}:${userId}`) || null;
  }

  function getRegistration(tournamentId, userId = currentUserId()) {
    return currentRegistration(tournamentId, userId);
  }

  function isTournamentJoined(tournamentId, userId = currentUserId()) {
    return currentRegistration(tournamentId, userId) !== null;
  }

  function getUserTournamentRegistrations(userId = currentUserId()) {
    if (!userId) return [];
    return [...sessionRegistrations.values()].filter((registration) => registration.userId === userId || registration.memberIds?.includes(userId));
  }

  function getMyTournaments() {
    return getUserTournamentRegistrations().map((registration) => getTournamentById(registration.tournamentId)).filter(Boolean);
  }

  function validateTournamentJoin(tournamentId, options = {}) {
    if (!currentUserId()) return { valid: false, reason: 'login', message: 'Log in to join this tournament.' };
    const tournament = getTournamentById(tournamentId);
    if (!tournament) return { valid: false, reason: 'missing', message: 'Tournament details are not available from the backend.' };
    if (isTournamentJoined(tournamentId)) return { valid: false, reason: 'duplicate', message: 'You are already registered in this session.' };
    return { valid: true, tournament, teamId: options.teamId || null };
  }

  async function joinTournament(tournamentId, options = {}) {
    try {
      const body = options.teamId ? { teamId: options.teamId } : {};
      const response = await api.request(`/api/tournaments/${encodeURIComponent(tournamentId)}/register`, { method: 'POST', body });
      const registration = response.registration;
      if (!registration || typeof registration.registrationId !== 'string') throw new Error('The backend returned an invalid registration.');
      sessionRegistrations.set(`${tournamentId}:${registration.userId}`, registration);
      const tournament = await loadTournament(tournamentId).catch(() => getTournamentById(tournamentId));
      return { success: true, registration, tournament };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function cancelRegistration(tournamentId) {
    try {
      await api.request(`/api/tournaments/${encodeURIComponent(tournamentId)}/register`, { method: 'DELETE' });
      for (const [key, registration] of sessionRegistrations) {
        if (registration.tournamentId === tournamentId) sessionRegistrations.delete(key);
      }
      await loadTournament(tournamentId).catch(() => null);
      return { success: true };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  function savePendingTournament(tournamentId) {
    if (!getTournamentById(tournamentId)) return false;
    try {
      localStorage.setItem('arenaX_pendingTournament', tournamentId);
      return true;
    } catch {
      return false;
    }
  }

  function getPendingTournament() {
    try {
      const id = localStorage.getItem('arenaX_pendingTournament');
      return id && getTournamentById(id) ? id : null;
    } catch {
      return null;
    }
  }

  function clearPendingTournament(tournamentId) {
    try {
      if (localStorage.getItem('arenaX_pendingTournament') !== tournamentId) return false;
      localStorage.removeItem('arenaX_pendingTournament');
      return true;
    } catch {
      return false;
    }
  }

  const tournaments = {
    ready: null,
    loadTournaments,
    loadTournament,
    getError: () => tournamentsError,
    isLoaded: () => tournamentsLoaded,
    getTournaments,
    getTournamentById,
    createTournament,
    updateTournament,
    getCurrentUser: () => auth?.getCurrentUser() || null,
    getAvailableSlots,
    isTournamentJoined,
    getRegistration,
    getUserTournamentRegistrations,
    getMyTournaments,
    getMyTournamentsAvailable: () => false,
    validateTournamentJoin,
    joinTournament,
    cancelRegistration,
    getParticipants: () => [],
    savePendingTournament,
    getPendingTournament,
    clearPendingTournament
  };

  function sessionHintKey() {
    const userId = currentUserId();
    return userId ? `arenaX_team_hint_${userId}` : null;
  }

  function getTeamHint() {
    const key = sessionHintKey();
    if (!key) return null;
    try {
      return sessionStorage.getItem(key) || auth?.getCurrentUser()?.teamId || null;
    } catch {
      return auth?.getCurrentUser()?.teamId || null;
    }
  }

  function setTeamHint(teamId) {
    const key = sessionHintKey();
    if (!key) return;
    try {
      if (teamId) sessionStorage.setItem(key, teamId);
      else sessionStorage.removeItem(key);
    } catch { /* The backend remains authoritative if browser hints cannot be stored. */ }
  }

  async function loadTeam(id) {
    if (typeof id !== 'string' || !id) return null;
    try {
      const response = await api.request(`/api/teams/${encodeURIComponent(id)}`);
      if (!response.team) throw new Error('The backend returned an invalid team record.');
      teamsError = null;
      return cacheTeam(response.team);
    } catch (error) {
      teamsError = error;
      throw error;
    }
  }

  async function loadUserTeam() {
    const id = getTeamHint();
    if (!id) {
      userTeamLookupError = null;
      return null;
    }
    try {
      const team = await loadTeam(id);
      if (!team.members.some((member) => member.userId === currentUserId())) {
        setTeamHint(null);
        return null;
      }
      userTeamLookupError = null;
      return team;
    } catch (error) {
      if (error.status === 404) setTeamHint(null);
      userTeamLookupError = error;
      return null;
    }
  }

  function getTeams() {
    return [...teamCache.values()];
  }

  function getTeamById(id) {
    return teamCache.get(id) || null;
  }

  function getUserTeam(userId = currentUserId()) {
    return getTeams().find((team) => team.status === 'active' && team.members.some((member) => member.userId === userId)) || null;
  }

  async function createTeam(details) {
    try {
      const response = await api.request('/api/teams', {
        method: 'POST',
        body: {
          teamName: String(details.teamName || '').trim(),
          teamTag: String(details.teamTag || '').trim().toUpperCase(),
          logo: String(details.logo || '').trim(),
          description: String(details.description || '').trim()
        }
      });
      const team = cacheTeam(response.team);
      setTeamHint(team.teamId);
      return { success: true, team };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function updateTeam(teamId, updates) {
    try {
      const response = await api.request(`/api/teams/${encodeURIComponent(teamId)}`, {
        method: 'PATCH',
        body: {
          ...(updates.teamName !== undefined ? { teamName: String(updates.teamName).trim() } : {}),
          ...(updates.teamTag !== undefined ? { teamTag: String(updates.teamTag).trim().toUpperCase() } : {}),
          ...(updates.logo !== undefined ? { logo: String(updates.logo).trim() } : {}),
          ...(updates.description !== undefined ? { description: String(updates.description).trim() } : {})
        }
      });
      return { success: true, team: cacheTeam(response.team) };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function addTeamMember(teamId, userId) {
    try {
      const response = await api.request(`/api/teams/${encodeURIComponent(teamId)}/members`, { method: 'POST', body: { userId } });
      return { success: true, team: cacheTeam(response.team) };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function removeTeamMember(teamId, userId) {
    try {
      const response = await api.request(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      const team = cacheTeam(response.team);
      if (!team.members.some((member) => member.userId === currentUserId())) setTeamHint(null);
      return { success: true, team };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function sendTeamInvitation(teamId, username) {
    const receiver = auth?.findUserByUsername(username);
    if (!receiver?.userId) return { success: false, reason: 'missing-user', message: 'That player is not available in the loaded account profiles.' };
    try {
      const response = await api.request(`/api/teams/${encodeURIComponent(teamId)}/invitations`, { method: 'POST', body: { receiverId: receiver.userId } });
      return { success: true, invitation: response.invitation };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function respondToInvitation(invitationId, status) {
    try {
      const response = await api.request(`/api/team-invitations/${encodeURIComponent(invitationId)}`, { method: 'PATCH', body: { status } });
      const invitation = response.invitation;
      if (status === 'accepted' && invitation?.teamId) {
        const team = await loadTeam(invitation.teamId).catch(() => null);
        if (team?.members.some((member) => member.userId === currentUserId())) setTeamHint(team.teamId);
      }
      return { success: true, invitation };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function acceptTeamInvitation(id) { return respondToInvitation(id, 'accepted'); }
  async function declineTeamInvitation(id) { return respondToInvitation(id, 'declined'); }
  function unsupportedTeamOperation() { return { success: false, reason: 'UNSUPPORTED', message: 'This team action is not available in the current backend API.' }; }
  function getTeamStats() { return null; }

  const teams = {
    ready: null,
    loadTeam,
    loadUserTeam,
    getError: () => teamsError,
    getTeams,
    getTeamById,
    getUserTeam,
    getUserTeamLookupError: () => userTeamLookupError,
    getTeamStats,
    createTeam,
    updateTeam,
    addTeamMember,
    removeTeamMember,
    leaveTeam: unsupportedTeamOperation,
    transferCaptain: unsupportedTeamOperation,
    getTeamInvitations: () => [],
    getUserInvitations: () => [],
    areInvitationListsAvailable: () => false,
    sendTeamInvitation,
    respondToInvitation,
    acceptTeamInvitation,
    declineTeamInvitation,
    getTeamTournamentRegistrations: () => [],
    areTournamentRegistrationsAvailable: () => false
  };

  async function loadMatches() {
    try {
      const response = await api.request('/api/matches');
      if (!Array.isArray(response.matches)) throw new Error('The backend returned an invalid match list.');
      matchCache.clear();
      response.matches.forEach(cacheMatch);
      matchesError = null;
    } catch (error) {
      matchesError = error;
      matchCache.clear();
    }
    matchesLoaded = true;
    return getMatches();
  }

  async function loadMatch(id) {
    if (typeof id !== 'string' || !id) return null;
    try {
      const response = await api.request(`/api/matches/${encodeURIComponent(id)}`);
      if (!response.match) throw new Error('The backend returned an invalid match record.');
      matchesError = null;
      return cacheMatch(response.match);
    } catch (error) {
      matchesError = error;
      throw error;
    }
  }

  function getMatches() { return [...matchCache.values()]; }
  function getMatchById(id) { return matchCache.get(id) || null; }
  function getMatchesByTournament(id) { return getMatches().filter((match) => match.tournamentId === id); }
  function getMyMatches() { return []; }
  function getAdminMatches() { return getMatches(); }
  function getAdminMatchById(id) { return getMatchById(id); }
  function getMatchParticipants() { return { registrations: [], players: [], teams: [] }; }
  function isOrganizer() { return Boolean(auth?.isAdmin?.()); }

  async function createMatch(details) {
    const startsAt = details.startsAt || isoFromLocalFields(details.date, details.startTime);
    const body = {
      tournamentId: details.tournamentId,
      matchNumber: Number(details.matchNumber),
      title: String(details.title || '').trim(),
      game: String(details.game || '').trim(),
      mode: String(details.mode || '').trim(),
      startsAt,
      maxPlayers: Number(details.maxPlayers),
      ...(details.map ? { map: String(details.map).trim() } : {}),
      ...(details.instructions ? { instructions: String(details.instructions).trim() } : {}),
      ...(details.status ? { status: details.status } : {}),
      ...(details.visibility ? { visibility: details.visibility } : {}),
      ...(Array.isArray(details.registrationIds) ? { registrationIds: details.registrationIds } : {}),
      ...(details.roomVisible !== undefined ? { roomVisible: Boolean(details.roomVisible) } : {}),
      ...(details.roomId ? { roomId: String(details.roomId) } : {}),
      ...(details.roomPassword ? { roomPassword: String(details.roomPassword) } : {})
    };
    try {
      const response = await api.request('/api/matches', { method: 'POST', body });
      return { success: true, match: cacheMatch(response.match) };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function updateMatch(id, updates) {
    const body = { ...updates };
    if (!String(body.roomId || '').trim()) delete body.roomId;
    if (!String(body.roomPassword || '').trim()) delete body.roomPassword;
    if (updates.date || updates.startTime) {
      const current = getMatchById(id);
      body.startsAt = isoFromLocalFields(updates.date || current?.date, updates.startTime || current?.startTime);
      delete body.date;
      delete body.startTime;
    }
    if (Array.isArray(body.participantRegistrationIds)) {
      body.registrationIds = body.participantRegistrationIds;
      delete body.participantRegistrationIds;
    }
    if (body.maxPlayers !== undefined) body.maxPlayers = Number(body.maxPlayers);
    delete body.winnerId;
    delete body.winnerName;
    delete body.placement;
    delete body.points;
    delete body.kills;
    delete body.remarks;
    delete body.resultStatus;
    try {
      const response = await api.request(`/api/matches/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      return { success: true, match: cacheMatch(response.match) };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function submitMatchResult(id, result) {
    const body = {
      status: result.status === 'submitted' ? 'submitted' : 'published',
      placement: Number(result.placement),
      points: Number(result.points),
      kills: Number(result.kills),
      ...(result.playerId ? { playerId: result.playerId } : {}),
      ...(result.teamId ? { teamId: result.teamId } : {}),
      ...(result.winnerName ? { winnerName: String(result.winnerName).trim() } : {}),
      ...(result.remarks ? { remarks: String(result.remarks).trim() } : {})
    };
    try {
      const response = await api.request(`/api/matches/${encodeURIComponent(id)}/result`, { method: 'POST', body });
      return { success: true, match: cacheMatch(response.match) };
    } catch (error) {
      return { success: false, reason: error.code, message: error.message };
    }
  }

  async function getRoomCredentials(id) {
    try {
      const response = await api.request(`/api/matches/${encodeURIComponent(id)}/room-credentials`);
      return response.room || null;
    } catch (error) {
      return { error: error.message, reason: error.code };
    }
  }

  const matches = {
    ready: null,
    loadMatches,
    loadMatch,
    getError: () => matchesError,
    isLoaded: () => matchesLoaded,
    getMatches,
    getMatchById,
    getMatchesByTournament,
    getMyMatches,
    getMyMatchesAvailable: () => false,
    getMatchParticipants,
    getAdminMatches,
    getAdminMatchById,
    getRoomCredentials,
    createMatch,
    updateMatch,
    submitMatchResult,
    isOrganizer
  };

  tournaments.ready = loadTournaments();
  teams.ready = Promise.resolve(auth?.ready).then(loadUserTeam);
  matches.ready = loadMatches();
  Object.freeze(tournaments);
  Object.freeze(teams);
  Object.freeze(matches);
  globalThis.ArenaCompetitionBackend = true;
  globalThis.ArenaTournaments = tournaments;
  globalThis.ArenaTeams = teams;
  globalThis.ArenaMatches = matches;
})();
