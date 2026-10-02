(() => {
  const AUDIT_KEY = 'arenaX_admin_activity';
  const auth = globalThis.ArenaAuth;
  const tournaments = globalThis.ArenaTournaments;
  const teams = globalThis.ArenaTeams;
  const matches = globalThis.ArenaMatches;
  const transactionTypes = new Set(['deposit', 'winning', 'refund', 'adjustment', 'withdrawal', 'entry_fee']);
  const transactionStatuses = new Set(['completed', 'pending', 'failed']);
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

  function isValidTransaction(transaction) {
    const amount = Number(transaction?.amount);
    return Boolean(transaction && typeof transaction === 'object' && !Array.isArray(transaction)
      && typeof transaction.id === 'string' && transaction.id.trim()
      && typeof transaction.userId === 'string' && transaction.userId.trim()
      && transactionTypes.has(transaction.type)
      && Number.isFinite(amount) && amount > 0 && amount <= 1000000
      && transactionStatuses.has(transaction.status)
      && typeof transaction.createdAt === 'string' && Number.isFinite(Date.parse(transaction.createdAt)));
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
    if (!isAuthorized()) return { totalUsers: 0, totalTournaments: 0, totalTeams: 0, totalMatches: 0, totalWalletTransactions: 0, totalWalletBalance: 0, activeTournaments: 0, liveMatches: 0, completedMatches: 0 };
    const users = auth.getUsers();
    const tournamentRecords = tournaments.getTournaments();
    const teamRecords = teams.getTeams();
    const matchRecords = matches.getMatches();
    const wallets = readArray('arenaX_wallets');
    const transactions = readArray('arenaX_transactions');
    return {
      totalUsers: users.length,
      totalTournaments: tournamentRecords.length,
      totalTeams: teamRecords.length,
      totalMatches: matchRecords.length,
      totalWalletTransactions: transactions.valid ? transactions.items.filter(isValidTransaction).length : 0,
      totalWalletBalance: wallets.valid ? wallets.items.reduce((total, wallet) => total + Math.max(0, Number(wallet?.balance) || 0), 0) : 0,
      activeTournaments: tournamentRecords.filter((tournament) => ['Upcoming', 'Live'].includes(tournament.status)).length,
      liveMatches: matchRecords.filter((match) => match.status === 'live').length,
      completedMatches: matchRecords.filter((match) => match.status === 'completed').length
    };
  }

  function getUsers() {
    if (!isAuthorized()) return [];
    return auth.getUsers().map((user) => ({
      ...user,
      accountStatus: user.status === 'suspended' ? 'suspended' : 'active'
    }));
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
      const participants = matches.getMatchParticipants(match);
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
        status: match.status,
        map: match.map,
        roomId: match.roomId || '',
        roomPassword: match.roomPassword || '',
        roomVisible: Boolean(match.roomVisible),
        resultStatus: match.resultStatus,
        participantCount: participants.registrations.length,
        updatedAt: match.updatedAt
      };
    });
  }

  function getWalletTransactions() {
    if (!isAuthorized()) return [];
    const state = readArray('arenaX_transactions');
    if (!state.valid) return [];
    return state.items.filter(isValidTransaction).map((transaction) => ({
      id: transaction.id,
      userId: transaction.userId,
      username: auth.getUserById(transaction.userId)?.username || 'Unknown user',
      type: transaction.type,
      amount: Number(transaction.amount) || 0,
      status: transaction.status,
      description: transaction.description,
      referenceId: transaction.referenceId || '',
      createdAt: transaction.createdAt
    })).sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
  }

  function getAdminActivity() {
    if (!isAuthorized()) return [];
    const state = readArray(AUDIT_KEY);
    return state.valid
      ? state.items.filter(isValidActivityRecord).sort((first, second) => new Date(second.timestamp) - new Date(first.timestamp))
      : [];
  }

  function setUserStatus(userId, status) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    if (!['active', 'suspended'].includes(status)) return { success: false, message: 'Choose a valid account status.' };
    if (!auth.getUsers().some((user) => user.userId === userId)) return { success: false, message: 'User not found.' };
    if (userId === auth.getCurrentUser().userId && status === 'suspended') return { success: false, message: 'You cannot suspend the current admin account.' };
    const result = auth.setUserStatus(userId, status);
    if (!result.success) return result;
    logAction('user_status_changed', 'user', userId, `Changed account status to ${status}.`);
    return { success: true, user: result.user };
  }

  async function setTournamentStatus(tournamentId, status) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    if (!['Upcoming', 'Live', 'Completed'].includes(status)) return { success: false, message: 'Choose a valid tournament status.' };
    const result = await tournaments.updateTournament(tournamentId, { status });
    if (!result.success) return result;
    logAction('tournament_status_changed', 'tournament', tournamentId, `Changed status to ${status}.`);
    return { success: true };
  }

  async function updateMatch(matchId, values) {
    if (!isAuthorized()) return { success: false, message: 'Admin access required.' };
    const result = await matches.updateMatch(matchId, {
      status: values.status,
      ...(values.roomId ? { roomId: values.roomId } : {}),
      ...(values.roomPassword ? { roomPassword: values.roomPassword } : {}),
      roomVisible: Boolean(values.roomVisible)
    });
    if (!result.success) return result;
    logAction('match_updated', 'match', matchId, `Changed match status to ${result.match.status} and updated room visibility.`);
    return { success: true };
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
    setUserStatus,
    setTournamentStatus,
    updateMatch
  });
})();