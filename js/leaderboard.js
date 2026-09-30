(() => {
  const matches = globalThis.ArenaMatches;
  const tournaments = globalThis.ArenaTournaments;
  const teams = globalThis.ArenaTeams;
  const auth = globalThis.ArenaAuth;
  if (!matches || !tournaments || !teams || !auth) return;

  const SCORING = Object.freeze({
    placementPointsByRank: Object.freeze({ 1: 10, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1 }),
    killPoints: 1
  });

  function calculateRows({ tournamentId = 'all', game = 'all' } = {}) {
    const rows = new Map();
    matches.getMatches().filter((match) => match.status === 'completed' && match.resultStatus === 'published' && Array.isArray(match.results) && match.results.length > 0)
      .forEach((match) => {
        const tournament = tournaments.getTournamentById(match.tournamentId);
        if (!tournament || (tournamentId !== 'all' && match.tournamentId !== tournamentId) || (game !== 'all' && tournament.game !== game)) return;
        const isSolo = tournament.type === 'Solo';
        const seen = new Set();
        match.results.forEach((result) => {
          const team = result.teamId ? teams.getTeamById(result.teamId) : null;
          const player = result.playerId ? auth.getUserById(result.playerId) : null;
          const entityId = isSolo ? result.playerId : result.teamId;
          const entityName = isSolo
            ? player?.username || result.winnerName
            : team?.teamName || result.winnerName;
          if (!entityName) return;
          const entityKey = entityId ? `${isSolo ? 'player' : 'team'}:${entityId}` : `${isSolo ? 'player' : 'team'}:${match.tournamentId}:${entityName.trim().toLowerCase()}`;
          const matchKey = `${entityKey}:${match.matchId}`;
          if (seen.has(matchKey)) return;
          seen.add(matchKey);
          const key = `${tournamentId === 'all' ? 'all' : match.tournamentId}:${entityKey}`;
          const row = rows.get(key) || {
            tournamentId: tournamentId === 'all' ? null : match.tournamentId,
            playerId: isSolo ? result.playerId || null : null,
            teamId: isSolo ? null : result.teamId || null,
            playerName: isSolo ? entityName : null,
            teamName: isSolo ? null : entityName,
            entityType: isSolo ? 'player' : 'team',
            matchesPlayed: 0,
            wins: 0,
            placement: null,
            kills: 0,
            points: 0,
            totalPoints: 0,
            tournamentNames: new Set(),
            teamMembers: team?.members?.map((member) => member.username).filter(Boolean) || []
          };
          const placement = Math.max(0, Number(result.placement) || 0);
          const kills = Math.max(0, Number(result.kills) || 0);
          const savedPlacementPoints = Number(result.points);
          const placementPoints = Number.isFinite(savedPlacementPoints)
            ? Math.max(0, savedPlacementPoints)
            : SCORING.placementPointsByRank[placement] || 0;
          row.matchesPlayed += 1;
          row.wins += placement === 1 ? 1 : 0;
          row.placement = row.placement === null ? placement : placement > 0 ? Math.min(row.placement || placement, placement) : row.placement;
          row.kills += kills;
          row.points += placementPoints;
          row.totalPoints += placementPoints + kills * SCORING.killPoints;
          row.tournamentNames.add(tournament.name);
          if (team?.members?.length) row.teamMembers = team.members.map((member) => member.username).filter(Boolean);
          rows.set(key, row);
        });
      });
    return [...rows.values()].map((row) => ({ ...row, tournamentNames: [...row.tournamentNames] }));
  }

  function getLeaderboard(options = {}) {
    return calculateRows(options);
  }

  globalThis.ArenaLeaderboard = Object.freeze({ getLeaderboard, getScoring: () => SCORING });

  if (document.body.dataset.page !== 'leaderboard') return;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const tableBody = document.querySelector('#leaderboard-results');
  const table = document.querySelector('#leaderboard-table');
  const tableWrap = document.querySelector('#leaderboard-table-wrap');
  const empty = document.querySelector('#leaderboard-empty');
  const count = document.querySelector('#leaderboard-result-count');
  const search = document.querySelector('#leaderboard-search');
  const tournamentFilter = document.querySelector('#leaderboard-tournament');
  const gameFilter = document.querySelector('#leaderboard-game');
  const sortFilter = document.querySelector('#leaderboard-sort');

  function populateFilters() {
    const selectedTournament = new URLSearchParams(location.search).get('tournamentId') || 'all';
    const allTournaments = tournaments.getTournaments();
    tournamentFilter.innerHTML = '<option value="all">All Tournaments</option>' + allTournaments.map((tournament) => `<option value="${escapeHtml(tournament.id)}">${escapeHtml(tournament.name)}</option>`).join('');
    tournamentFilter.value = allTournaments.some((tournament) => tournament.id === selectedTournament) ? selectedTournament : 'all';
    const games = [...new Set(allTournaments.map((tournament) => tournament.game).filter(Boolean))].sort();
    gameFilter.innerHTML = '<option value="all">All Games</option>' + games.map((game) => `<option value="${escapeHtml(game)}">${escapeHtml(game)}</option>`).join('');
  }

  function currentPlayerLink(row) {
    const user = auth.getCurrentUser();
    return row.playerId && user?.userId === row.playerId
      ? `<a class="leaderboard-entity-link" href="profile.html">${escapeHtml(row.playerName)}</a>`
      : escapeHtml(row.playerName || row.teamName);
  }

  function render() {
    const options = { tournamentId: tournamentFilter.value, game: gameFilter.value };
    const rows = calculateRows(options);
    const query = search.value.trim().toLowerCase();
    const filtered = rows.filter((row) => [row.playerName, row.teamName, ...row.teamMembers].join(' ').toLowerCase().includes(query));
    const sortBy = sortFilter.value;
    const sorters = {
      points: (first, second) => second.totalPoints - first.totalPoints,
      wins: (first, second) => second.wins - first.wins || second.totalPoints - first.totalPoints,
      kills: (first, second) => second.kills - first.kills || second.totalPoints - first.totalPoints,
      matches: (first, second) => second.matchesPlayed - first.matchesPlayed || second.totalPoints - first.totalPoints,
      rank: (first, second) => second.totalPoints - first.totalPoints
    };
    filtered.sort(sorters[sortBy] || sorters.points);
    filtered.forEach((row, index) => { row.rank = index + 1; });
    tableBody.innerHTML = filtered.map((row) => {
      const team = row.teamId ? teams.getTeamById(row.teamId) : null;
      const canOpenTeam = team?.members.some((member) => member.userId === auth.getCurrentUser()?.userId);
      const teamHref = canOpenTeam ? `team.html?id=${encodeURIComponent(row.teamId)}` : null;
      const entity = row.entityType === 'team' && teamHref
        ? `<a class="leaderboard-entity-link" href="${teamHref}">${escapeHtml(row.teamName)}</a>`
        : currentPlayerLink(row);
      const memberNames = row.entityType === 'team' && row.teamMembers.length ? row.teamMembers.join(', ') : row.tournamentNames.join(', ');
      return `<tr><td data-label="RANK"><span class="leaderboard-rank-badge ${row.rank <= 3 ? 'is-podium' : ''}">${String(row.rank).padStart(2, '0')}</span></td><td data-label="PLAYER / TEAM"><div class="leaderboard-entity"><strong>${entity}</strong><span>${escapeHtml(memberNames)}</span></div></td><td data-label="MATCHES">${row.matchesPlayed}</td><td data-label="WINS">${row.wins}</td><td data-label="KILLS">${row.kills}</td><td data-label="PLACEMENT POINTS">${row.points}</td><td data-label="TOTAL POINTS"><strong class="leaderboard-total-points">${row.totalPoints}</strong></td></tr>`;
    }).join('');
    table.hidden = filtered.length === 0;
    tableWrap.hidden = filtered.length === 0;
    empty.hidden = filtered.length !== 0;
    if (filtered.length) empty.querySelector('h2').textContent = 'No players or teams found.';
    else if (query) empty.querySelector('h2').textContent = 'No players or teams found.';
    else if (!rows.length && !calculateRows({ tournamentId: 'all', game: 'all' }).length) empty.querySelector('h2').textContent = 'No completed matches yet.';
    else empty.querySelector('h2').textContent = 'No leaderboard data yet.';
    count.textContent = `${String(filtered.length).padStart(2, '0')} ${filtered.length === 1 ? 'RANKED ENTRY' : 'RANKED ENTRIES'}`;
  }

  populateFilters();
  [tournamentFilter, gameFilter, sortFilter].forEach((filter) => filter.addEventListener('change', render));
  search.addEventListener('input', render);
  document.querySelector('#leaderboard-controls').addEventListener('submit', (event) => event.preventDefault());
  render();
})();
