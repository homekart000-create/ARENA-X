// Demo-only localStorage records are not authoritative; production events need server-side validation and a secure database.
(() => {
  const TOURNAMENTS_KEY = 'arenaX_tournaments';
  const PARTICIPANTS_KEY = 'arenaX_participants';
  const PENDING_TOURNAMENT_KEY = 'arenaX_pendingTournament';

  const demoRules = [
    'Players must use their registered ARENA X account.',
    'Cheating, exploits, and unauthorized software are prohibited.',
    'No teaming outside the registered team or bracket.',
    'Players must join before the registration deadline.',
    'Room information will be provided before the match.',
    'All players must follow tournament instructions.',
    'Admin decisions apply to tournament disputes.'
  ];

  const standardPrizes = [
    { place: '1st Place', percentage: 50 },
    { place: '2nd Place', percentage: 25 },
    { place: '3rd Place', percentage: 15 },
    { place: '4th-10th', percentage: 10 }
  ];

  const sampleTournaments = [
    {
      id: 'arena-x-free-fire-clash', name: 'ARENA X Free Fire Clash', game: 'Free Fire', type: 'Squad', entryFee: 99, prizePool: 50000, maxSlots: 100, joinedSlots: 72,
      startDate: '2026-10-04', startTime: '7:30 PM IST', registrationDeadline: '2026-10-04T18:30:00', status: 'Upcoming', banner: 'ember',
      description: 'Drop into Bermuda with your squad and fight through a high-stakes community clash. Placement and eliminations both count toward the final standings.',
      rules: [...demoRules], map: 'Bermuda', mode: 'Battle Royale / 4 rounds', host: 'ARENA X Community', prizeDistribution: [...standardPrizes], featured: true, createdAt: '2026-09-20T10:00:00'
    },
    {
      id: 'arena-x-night-battle', name: 'ARENA X Night Battle', game: 'Free Fire', type: 'Duo', entryFee: 49, prizePool: 15000, maxSlots: 48, joinedSlots: 28,
      startDate: '2026-10-02', startTime: '9:00 PM IST', registrationDeadline: '2026-10-02T20:00:00', status: 'Upcoming', banner: 'night',
      description: 'A two-player night series built around quick rotations, smart revives, and clutch finishes.',
      rules: [...demoRules], map: 'Purgatory', mode: 'Battle Royale / 3 rounds', host: 'ARENA X Night Ops', prizeDistribution: [...standardPrizes], featured: true, createdAt: '2026-09-22T14:00:00'
    },
    {
      id: 'arena-x-weekend-warriors', name: 'ARENA X Weekend Warriors', game: 'Free Fire', type: 'Squad', entryFee: 0, prizePool: 12000, maxSlots: 100, joinedSlots: 55,
      startDate: '2026-10-05', startTime: '5:00 PM IST', registrationDeadline: '2026-10-05T16:00:00', status: 'Upcoming', banner: 'citadel',
      description: 'Open-entry weekend competition for squads ready to turn teamwork into a top-ten finish.',
      rules: [...demoRules], map: 'Alpine', mode: 'Battle Royale / 3 rounds', host: 'ARENA X Community', prizeDistribution: [...standardPrizes], featured: true, createdAt: '2026-09-23T09:30:00'
    },
    {
      id: 'arena-x-booyah-cup', name: 'ARENA X Booyah Cup', game: 'Free Fire', type: 'Solo', entryFee: 149, prizePool: 75000, maxSlots: 64, joinedSlots: 64,
      startDate: '2026-10-01', startTime: '6:30 PM IST', registrationDeadline: '2026-10-01T17:30:00', status: 'Upcoming', banner: 'crown',
      description: 'A sold-out solo cup rewarding survival, discipline, and decisive end-game fights.',
      rules: [...demoRules], map: 'Bermuda', mode: 'Battle Royale / 4 rounds', host: 'ARENA X Competitive', prizeDistribution: [...standardPrizes], featured: true, createdAt: '2026-09-17T12:00:00'
    },
    {
      id: 'arena-x-squad-masters', name: 'ARENA X Squad Masters', game: 'Free Fire', type: 'Squad', entryFee: 199, prizePool: 100000, maxSlots: 48, joinedSlots: 41,
      startDate: '2026-10-10', startTime: '8:00 PM IST', registrationDeadline: '2026-10-10T19:00:00', status: 'Upcoming', banner: 'neon',
      description: 'The featured squad championship. Four rounds, a deep field, and a prize pool built for serious contenders.',
      rules: [...demoRules], map: 'Bermuda', mode: 'Battle Royale / 4 rounds', host: 'ARENA X Competitive', prizeDistribution: [...standardPrizes], featured: true, createdAt: '2026-09-24T11:00:00'
    },
    {
      id: 'arena-x-solo-kings', name: 'ARENA X Solo Kings', game: 'Free Fire', type: 'Solo', entryFee: 0, prizePool: 5000, maxSlots: 100, joinedSlots: 88,
      startDate: '2026-10-03', startTime: '4:00 PM IST', registrationDeadline: '2026-10-03T15:00:00', status: 'Upcoming', banner: 'solar',
      description: 'A free solo ladder where every placement point matters. New competitors are welcome.',
      rules: [...demoRules], map: 'Nexterra', mode: 'Battle Royale / 2 rounds', host: 'ARENA X Community', prizeDistribution: [...standardPrizes], featured: true, createdAt: '2026-09-25T08:00:00'
    },
    {
      id: 'arena-x-grand-battle', name: 'ARENA X Grand Battle', game: 'Free Fire', type: 'Duo', entryFee: 79, prizePool: 25000, maxSlots: 48, joinedSlots: 14,
      startDate: '2026-10-07', startTime: '7:00 PM IST', registrationDeadline: '2026-10-07T18:00:00', status: 'Upcoming', banner: 'vector',
      description: 'Pair up for a midweek battle across two maps, with a final round to settle the leaderboard.',
      rules: [...demoRules], map: 'Kalahari', mode: 'Battle Royale / 3 rounds', host: 'ARENA X Community', prizeDistribution: [...standardPrizes], featured: false, createdAt: '2026-09-26T15:00:00'
    },
    {
      id: 'arena-x-pro-league', name: 'ARENA X Pro League', game: 'Valorant', type: 'Squad', entryFee: 250, prizePool: 200000, maxSlots: 32, joinedSlots: 20,
      startDate: '2026-10-12', startTime: '6:00 PM IST', registrationDeadline: '2026-10-12T17:00:00', status: 'Upcoming', banner: 'void',
      description: 'A tactical five-player bracket for coordinated teams. Map veto and match timings are demo format details.',
      rules: [...demoRules], map: 'Ascent', mode: '5v5 / Single elimination', host: 'ARENA X Esports', prizeDistribution: [...standardPrizes], featured: false, createdAt: '2026-09-21T11:00:00'
    },
    {
      id: 'arena-x-elite-clash', name: 'ARENA X Elite Clash', game: 'BGMI', type: 'Squad', entryFee: 99, prizePool: 40000, maxSlots: 64, joinedSlots: 33,
      startDate: '2026-10-08', startTime: '7:30 PM IST', registrationDeadline: '2026-10-08T18:30:00', status: 'Upcoming', banner: 'steel',
      description: 'A squad battle royale for teams looking to prove their consistency over three classic maps.',
      rules: [...demoRules], map: 'Erangel', mode: 'Battle Royale / 3 rounds', host: 'ARENA X Community', prizeDistribution: [...standardPrizes], featured: false, createdAt: '2026-09-19T12:00:00'
    },
    {
      id: 'arena-x-championship', name: 'ARENA X Championship', game: 'Call of Duty Mobile', type: 'Squad', entryFee: 199, prizePool: 100000, maxSlots: 64, joinedSlots: 18,
      startDate: '2026-10-18', startTime: '5:30 PM IST', registrationDeadline: '2026-10-18T16:30:00', status: 'Upcoming', banner: 'inferno',
      description: 'A mobile squad championship featuring a demo mix of tactical search and destroy and hardpoint rounds.',
      rules: [...demoRules], map: 'Crash', mode: '5v5 / Bracket', host: 'ARENA X Esports', prizeDistribution: [...standardPrizes], featured: false, createdAt: '2026-09-18T12:00:00'
    },
    {
      id: 'arena-x-rookie-rush', name: 'ARENA X Rookie Rush', game: 'Free Fire', type: 'Duo', entryFee: 0, prizePool: 8000, maxSlots: 100, joinedSlots: 73,
      startDate: '2026-09-29', startTime: '7:00 PM IST', registrationDeadline: '2026-09-29T23:59:00', status: 'Live', banner: 'pulse',
      description: 'A live-entry community lobby for new duos. Follow the room instructions and play for position.',
      rules: [...demoRules], map: 'Bermuda', mode: 'Battle Royale / 2 rounds', host: 'ARENA X Community', prizeDistribution: [...standardPrizes], featured: false, createdAt: '2026-09-15T09:00:00'
    },
    {
      id: 'arena-x-classic-series', name: 'ARENA X Classic Series', game: 'Free Fire', type: 'Solo', entryFee: 49, prizePool: 10000, maxSlots: 64, joinedSlots: 64,
      startDate: '2026-09-20', startTime: '6:00 PM IST', registrationDeadline: '2026-09-20T17:00:00', status: 'Completed', banner: 'trophy',
      description: 'The previous ARENA X community solo series is complete. Review its example standings and prize split.',
      rules: [...demoRules], map: 'Purgatory', mode: 'Battle Royale / 3 rounds', host: 'ARENA X Community', prizeDistribution: [...standardPrizes], featured: false, createdAt: '2026-09-10T09:00:00'
    }
  ];

  const tournamentStatuses = new Set(['Upcoming', 'Live', 'Completed']);

  function isValidTournament(tournament) {
    if (!tournament || typeof tournament !== 'object' || Array.isArray(tournament)) return false;
    if (typeof tournament.id !== 'string' || !/^[a-z0-9_-]+$/i.test(tournament.id)
      || !['name', 'game', 'type', 'mode', 'startDate', 'startTime', 'registrationDeadline'].every((field) => typeof tournament[field] === 'string' && tournament[field].trim())
      || !tournamentStatuses.has(tournament.status)
      || !/^\d{4}-\d{2}-\d{2}$/.test(tournament.startDate)
      || Number.isNaN(Date.parse(`${tournament.startDate}T12:00:00`))
      || !Number.isFinite(Date.parse(tournament.registrationDeadline))) return false;
    if (![tournament.entryFee, tournament.prizePool, tournament.maxSlots, tournament.joinedSlots].every((value) => Number.isFinite(value) && value >= 0)) return false;
    if (tournament.maxSlots < 1 || tournament.joinedSlots > tournament.maxSlots) return false;
    if (!Array.isArray(tournament.rules) || !tournament.rules.every((rule) => typeof rule === 'string')) return false;
    if (!Array.isArray(tournament.prizeDistribution) || !tournament.prizeDistribution.every((prize) => prize
      && typeof prize === 'object' && typeof prize.place === 'string'
      && Number.isFinite(prize.percentage) && prize.percentage >= 0)) return false;
    return true;
  }

  function isValidRegistration(registration) {
    return Boolean(registration && typeof registration === 'object' && !Array.isArray(registration)
      && typeof registration.registrationId === 'string' && registration.registrationId.trim()
      && typeof registration.userId === 'string' && registration.userId.trim()
      && typeof registration.tournamentId === 'string' && registration.tournamentId.trim()
      && (registration.memberIds === undefined || (Array.isArray(registration.memberIds) && registration.memberIds.every((id) => typeof id === 'string')))
      && (registration.teamId === undefined || registration.teamId === null || typeof registration.teamId === 'string')
      && (registration.status === undefined || ['registered', 'cancelled'].includes(String(registration.status).toLowerCase()))
      && (registration.registeredAt === undefined || (typeof registration.registeredAt === 'string' && Number.isFinite(Date.parse(registration.registeredAt)))));
  }

  function hasInvalidStoredRecords(key, validator) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return false;
      const parsed = JSON.parse(raw);
      return !Array.isArray(parsed) || !parsed.every(validator);
    } catch {
      return true;
    }
  }

  function readArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function writeArray(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function getTournaments() {
    try {
      const raw = localStorage.getItem(TOURNAMENTS_KEY);
      if (raw !== null) {
        const saved = JSON.parse(raw);
        return Array.isArray(saved) ? saved.filter(isValidTournament) : [];
      }
    } catch {
      return [];
    }
    const seeded = sampleTournaments.map((tournament) => structuredClone(tournament));
    saveTournaments(seeded);
    return seeded;
  }

  function saveTournaments(tournaments) {
    if (!Array.isArray(tournaments) || !tournaments.every(isValidTournament)
      || hasInvalidStoredRecords(TOURNAMENTS_KEY, isValidTournament)) return false;
    return writeArray(TOURNAMENTS_KEY, tournaments);
  }

  function saveTournament(tournament) {
    if (!tournament?.id) return false;
    const tournaments = getTournaments();
    const existingIndex = tournaments.findIndex((entry) => entry.id === tournament.id);
    const next = existingIndex < 0
      ? [...tournaments, tournament]
      : tournaments.map((entry, index) => index === existingIndex ? tournament : entry);
    return saveTournaments(next);
  }

  function getTournamentById(id) {
    if (typeof id !== 'string' || !/^[a-z0-9_-]+$/i.test(id)) return null;
    return getTournaments().find((tournament) => tournament.id === id) || null;
  }

  function getCurrentUser() {
    return globalThis.ArenaAuth?.getCurrentUser() || null;
  }

  function saveCurrentUser(user) {
    if (!user?.userId || !globalThis.ArenaAuth?.updateUser) return { success: false, message: 'Authentication is unavailable.' };
    return globalThis.ArenaAuth.updateUser(user.userId, {
      joinedTournaments: Array.isArray(user.joinedTournaments) ? user.joinedTournaments : []
    });
  }

  function getParticipants() {
    return readArray(PARTICIPANTS_KEY).filter(isValidRegistration);
  }

  function getRegistration(tournamentId, userId = getCurrentUser()?.userId) {
    if (!userId || !getTournamentById(tournamentId)) return null;
    return getParticipants().find((entry) => entry.tournamentId === tournamentId
      && (entry.userId === userId || entry.memberIds?.includes(userId))
      && String(entry.status || 'registered').toLowerCase() !== 'cancelled') || null;
  }

  function getUserTournamentRegistrations(userId = getCurrentUser()?.userId) {
    if (!userId) return [];
    return getParticipants().filter((entry) => (entry.userId === userId || entry.memberIds?.includes(userId))
      && String(entry.status || 'registered').toLowerCase() !== 'cancelled');
  }

  function getAvailableSlots(tournamentOrId) {
    const tournament = typeof tournamentOrId === 'string' ? getTournamentById(tournamentOrId) : tournamentOrId;
    return tournament ? Math.max(0, tournament.maxSlots - tournament.joinedSlots) : 0;
  }

  function isTournamentJoined(tournamentId, userId = getCurrentUser()?.userId) {
    if (!userId) return false;
    const user = getCurrentUser();
    return getRegistration(tournamentId, userId) !== null
      || (user?.userId === userId && user.joinedTournaments?.includes(tournamentId));
  }

  function getMyTournaments() {
    const user = getCurrentUser();
    if (!user) return [];
    const joinedIds = new Set([
      ...(Array.isArray(user.joinedTournaments) ? user.joinedTournaments : []),
      ...getUserTournamentRegistrations(user.userId).map((entry) => entry.tournamentId)
    ]);
    return getTournaments().filter((tournament) => joinedIds.has(tournament.id));
  }

  function validateTournamentJoin(tournamentId, options = {}) {
    const user = getCurrentUser();
    if (!user) return { valid: false, reason: 'login', message: 'Log in to join this tournament.' };
    const tournament = getTournamentById(tournamentId);
    if (!tournament) return { valid: false, reason: 'missing', message: 'This tournament could not be found.' };
    if (isTournamentJoined(tournamentId, user.userId)) return { valid: false, reason: 'duplicate', message: 'You have already joined this tournament.' };
    if (tournament.status === 'Completed') return { valid: false, reason: 'completed', message: 'Registration is closed because this tournament is completed.' };
    if (getAvailableSlots(tournament) <= 0) return { valid: false, reason: 'full', message: 'This tournament is full.' };
    const deadline = new Date(tournament.registrationDeadline).getTime();
    if (Number.isNaN(deadline) || Date.now() > deadline) return { valid: false, reason: 'deadline', message: 'The registration deadline has passed.' };
    let team = null;
    let captainId = user.userId;
    let memberIds = [user.userId];
    if (tournament.type === 'Duo' || tournament.type === 'Squad') {
      const teams = globalThis.ArenaTeams;
      team = options.teamId ? teams?.getTeamById(options.teamId) : teams?.getUserTeam(user.userId);
      if (!team || !team.members.some((member) => member.userId === user.userId)) {
        return { valid: false, reason: 'team-required', message: 'Team required. Create or join a team to enter this tournament.' };
      }
      const requiredMembers = tournament.type === 'Duo' ? 2 : 4;
      if (team.members.length !== requiredMembers) {
        return { valid: false, reason: 'team-size', message: `Your team needs ${requiredMembers} members for this ${tournament.type} tournament.` };
      }
      memberIds = [...new Set(team.members.map((member) => member.userId))];
      if (memberIds.length !== requiredMembers) return { valid: false, reason: 'team-size', message: `Your team needs ${requiredMembers} members for this ${tournament.type} tournament.` };
      captainId = team.ownerId;
      const conflict = getParticipants().some((registration) => {
        if (registration.tournamentId !== tournamentId || String(registration.status || 'registered').toLowerCase() === 'cancelled') return false;
        const registeredMembers = [registration.userId, ...(registration.memberIds || [])];
        return registeredMembers.some((memberId) => memberIds.includes(memberId));
      });
      if (conflict) return { valid: false, reason: 'team-conflict', message: 'A player on this team is already registered with another team for this tournament.' };
    }
    return { valid: true, user, tournament, team, captainId, memberIds };
  }

  function createRegistrationId() {
    return globalThis.crypto?.randomUUID?.() || `registration-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function joinTournament(tournamentId, options = {}) {
    const validation = validateTournamentJoin(tournamentId, options);
    if (!validation.valid) return { success: false, reason: validation.reason, message: validation.message };
    if (hasInvalidStoredRecords(PARTICIPANTS_KEY, isValidRegistration)) {
      return { success: false, reason: 'storage', message: 'Registration storage contains invalid records and was left unchanged.' };
    }
    const { user, tournament, team, captainId, memberIds } = validation;
    const tournaments = getTournaments();
    const tournamentIndex = tournaments.findIndex((entry) => entry.id === tournamentId);
    if (tournamentIndex < 0 || getAvailableSlots(tournaments[tournamentIndex]) <= 0) {
      return { success: false, reason: 'full', message: 'This tournament is full.' };
    }

    const participants = getParticipants();
    const registration = {
      registrationId: createRegistrationId(),
      userId: user.userId,
      tournamentId,
      username: user.username,
      fullName: user.fullName,
      registeredAt: new Date().toISOString(),
      status: 'registered',
      teamId: team?.teamId || null,
      captainId,
      memberIds,
      matchId: null
    };
    const nextParticipants = [...participants, registration];
    const nextTournaments = tournaments.map((entry, index) => index === tournamentIndex
      ? { ...entry, joinedSlots: Math.min(entry.maxSlots, entry.joinedSlots + 1) }
      : entry);
    if (!writeArray(PARTICIPANTS_KEY, nextParticipants)) return { success: false, reason: 'storage', message: 'Your browser could not save this registration.' };
    if (!saveTournaments(nextTournaments)) {
      writeArray(PARTICIPANTS_KEY, participants);
      return { success: false, reason: 'storage', message: 'Your browser could not save this registration.' };
    }
    const updatedUsers = [];
    for (const memberId of memberIds) {
      const member = globalThis.ArenaAuth.getUserById(memberId);
      if (!member) {
        updatedUsers.forEach((prior) => globalThis.ArenaAuth.updateUser(prior.userId, { joinedTournaments: prior.joinedTournaments }));
        writeArray(PARTICIPANTS_KEY, participants);
        saveTournaments(tournaments);
        return { success: false, reason: 'team-member-missing', message: 'A registered team member account could not be found.' };
      }
      const update = globalThis.ArenaAuth.updateUser(memberId, {
        joinedTournaments: [...new Set([...(member.joinedTournaments || []), tournamentId])]
      });
      if (!update.success) {
        updatedUsers.forEach((prior) => globalThis.ArenaAuth.updateUser(prior.userId, { joinedTournaments: prior.joinedTournaments }));
        writeArray(PARTICIPANTS_KEY, participants);
        saveTournaments(tournaments);
        return { success: false, reason: 'storage', message: update.message || 'Your browser could not save this registration.' };
      }
      updatedUsers.push({ userId: memberId, joinedTournaments: member.joinedTournaments || [] });
    }
    return { success: true, tournament: nextTournaments[tournamentIndex], user: globalThis.ArenaAuth.getCurrentUser(), registration };
  }

  function savePendingTournament(tournamentId) {
    if (!getTournamentById(tournamentId)) return false;
    try {
      localStorage.setItem(PENDING_TOURNAMENT_KEY, tournamentId);
      return true;
    } catch {
      return false;
    }
  }

  function getPendingTournament() {
    try {
      const id = localStorage.getItem(PENDING_TOURNAMENT_KEY);
      return id && getTournamentById(id) ? id : null;
    } catch {
      return null;
    }
  }

  function clearPendingTournament(tournamentId) {
    try {
      if (localStorage.getItem(PENDING_TOURNAMENT_KEY) !== tournamentId) return false;
      localStorage.removeItem(PENDING_TOURNAMENT_KEY);
      return true;
    } catch {
      return false;
    }
  }

  const api = Object.freeze({
    getTournaments,
    saveTournaments,
    saveTournament,
    getTournamentById,
    getCurrentUser,
    saveCurrentUser,
    saveUser: saveCurrentUser,
    isTournamentJoined,
    getRegistration,
    getUserTournamentRegistrations,
    getAvailableSlots,
    validateTournamentJoin,
    joinTournament,
    getMyTournaments,
    getParticipants,
    savePendingTournament,
    getPendingTournament,
    clearPendingTournament
  });

  globalThis.ArenaTournaments = api;
  getTournaments();
})();
