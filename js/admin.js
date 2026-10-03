(() => {
  const AUDIT_KEY = 'arenaX_admin_activity';
  const auth = globalThis.ArenaAuth;
  const tournaments = globalThis.ArenaTournaments;
  const teams = globalThis.ArenaTeams;
  const matches = globalThis.ArenaMatches;
  if (!auth || !tournaments || !teams || !matches) return;

  function isAuthorized() {
    return auth.isAdmin();
  }

  function readArray(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return { items: [], valid: true };
      const value = JSON.parse(raw);
      return Array.isArray(value) ? { items: value, valid: true } : { items: [], valid: false };
    } catch {
      return { items: [], valid: false };
    }
  }

  function isValidActivityRecord(record) {
    return Boolean(record && typeof record === 'object' && !Array.isArray(record)
      && typeof record.id === 'string' && record.id.trim()
      && typeof record.adminUserId === 'string' && record.adminUserId.trim()
      && typeof record.action === 'string' && record.action.trim()
      && typeof record.targetType === 'string'
      && typeof record.targetId === 'string'
      && typeof record.description === 'string'
      && typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)));
  }

  function makeId() {
    return globalThis.crypto?.randomUUID?.() || `admin-action-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function logAction(action, targetType, targetId, description) {
    if (!isAuthorized()) return false;
    const state = readArray(AUDIT_KEY);
    if (!state.valid) return false;
    const record = {
      id: makeId(),
      adminUserId: auth.getCurrentUser().userId,
      action,
      targetType,
      targetId: String(targetId || ''),
      timestamp: new Date().toISOString(),
      description: String(description || '').slice(0, 240)
    };
    try {
      localStorage.setItem(AUDIT_KEY, JSON.stringify([...state.items, record]));
      return true;
    } catch {
      return false;
    }
  }

  function getSummary() {
    if (!isAuthorized()) return { totalUsers: null, totalTournaments: 0, totalTeams: 0, totalMatches: 0, totalWalletTransactions: null, totalWalletBalance: null, activeTournaments: 0, liveMatches: 0, completedMatches: 0 };
    const tournamentRecords = tournaments.getTournaments();
    const teamRecords = teams.getTeams();
    const matchRecords = matches.getMatches();
    return {
      totalUsers: null,
      totalTournaments: tournamentRecords.length,
      totalTeams: teamRecords.length,
      totalMatches: matchRecords.length,
      totalWalletTransactions: null,
      totalWalletBalance: null,
      activeTournaments: tournamentRecords.filter((tournament) => ['Upcoming', 'Live'].includes(tournament.status)).length,
      liveMatches: matchRecords.filter((match) => match.status === 'live').length,
      completedMatches: matchRecords.filter((match) => match.status === 'completed').length
    };
  }

  function getUsers() {
    if (!isAuthorized()) return [];
    return null;
  }

  function getTournaments() {
    if (!isAuthorized()) return [];
    return tournaments.getTournaments().map((tournament) => ({ ...tournament }));
  }

  function getTeams() {
    if (!isAuthorized()) return [];
    return teams.getTeams().map((team) => ({
      teamId: team.teamId,
      teamName: team.teamName,
      teamTag: team.teamTag,
      ownerId: team.ownerId,
      ownerName: auth.getUserById(team.ownerId)?.username || 'Unknown player',
      members: (team.members || []).map((member) => ({ username: member.username, userId: member.userId, role: member.role })),
      memberCount: (team.members || []).length,
      createdAt: team.createdAt,
      status: team.status,
      stats: teams.getTeamStats(team.teamId)
    }));
  }

  function getMatches() {
    if (!isAuthorized()) return [];
    return matches.getAdminMatches().map((match) => {
      const tournament = tournaments.getTournamentById(match.tournamentId);
      return {
        matchId: match.matchId,
        tournamentId: match.tournamentId,
        tournamentName: tournament?.name || 'Tournament unavailable',
        matchNumber: match.matchNumber,
        title: match.title,
        game: match.game,
        mode: match.mode,
        date: match.date,
        startTime: match.startTime,
        startsAt: match.startsAt,
        status: match.status,
        map: match.map,
        roomVisible: Boolean(match.roomVisible),
        resultStatus: match.resultStatus,
        participantCount: match.participantCount,
        updatedAt: match.updatedAt
      };
    });
  }

  function getWalletTransactions() {
    if (!isAuthorized()) return [];
    return null;
  }

  function getAdminActivity() {
    if (!isAuthorized()) return [];
    const state = readArray(AUDIT_KEY);
    return state.valid
      ? state.items.filter(isValidActivityRecord).sort((first, second) => new Date(second.timestamp) - new Date(first.timestamp))
      : [];
  }

  async function setTournamentStatus(tournamentId, status) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    if (!['draft', 'upcoming', 'live', 'completed', 'cancelled'].includes(String(status).toLowerCase())) return { success: false, message: 'Choose a valid tournament status.' };
    const result = await tournaments.updateTournament(tournamentId, { status });
    if (!result.success) return result;
    logAction('tournament_status_changed', 'tournament', tournamentId, `Changed status to ${status}.`);
    return { success: true };
  }

  async function createTournament(values) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    const result = await tournaments.createTournament(values);
    if (!result.success) return result;
    logAction('tournament_created', 'tournament', result.tournament.id, 'Created a tournament.');
    return result;
  }

  async function updateTournament(tournamentId, values) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    const result = await tournaments.updateTournament(tournamentId, values);
    if (!result.success) return result;
    logAction('tournament_updated', 'tournament', tournamentId, 'Updated tournament details.');
    return result;
  }

  async function createMatch(values) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    const result = await matches.createMatch(values);
    if (!result.success) return result;
    logAction('match_created', 'match', result.match.matchId, 'Created a tournament match.');
    return result;
  }

  async function updateMatch(matchId, values) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    const result = await matches.updateMatch(matchId, {
      ...values,
      ...(values.roomId ? { roomId: values.roomId } : {}),
      ...(values.roomPassword ? { roomPassword: values.roomPassword } : {}),
      ...(values.roomVisible !== undefined ? { roomVisible: Boolean(values.roomVisible) } : {})
    });
    if (!result.success) return result;
    logAction('match_updated', 'match', matchId, `Updated match details; status is ${result.match.status}.`);
    return { success: true };
  }

  async function submitMatchResult(matchId, values) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    const result = await matches.submitMatchResult(matchId, values);
    if (!result.success) return result;
    logAction('match_result_recorded', 'match', matchId, `Recorded a match result with status ${values.status || 'published'}.`);
    return result;
  }

  async function getMatchParticipants(matchId) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    return matches.getMatchParticipants(matchId);
  }

  async function getTournamentParticipants(tournamentId) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    return tournaments.getTournamentParticipants(tournamentId);
  }

  async function notifyMatchPlayers(matchId) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    const result = await matches.notifyMatchPlayers(matchId);
    if (!result.success) return result;
    logAction('match_room_published', 'match', matchId, `Published room access and notified ${result.notified} registered players.`);
    return result;
  }

  globalThis.ArenaAdmin = Object.freeze({
    isAuthorized,
    getSummary,
    getUsers,
    getTournaments,
    getTeams,
    getMatches,
    getWalletTransactions,
    getAdminActivity,
    createTournament,
    updateTournament,
    setTournamentStatus,
    createMatch,
    updateMatch,
    submitMatchResult,
    getMatchParticipants,
    getTournamentParticipants,
    notifyMatchPlayers
  });
})();