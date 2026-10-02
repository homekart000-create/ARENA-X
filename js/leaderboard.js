(() => {
  const matches = globalThis.ArenaMatches;
  const tournaments = globalThis.ArenaTournaments;
  const teams = globalThis.ArenaTeams;
  const auth = globalThis.ArenaAuth;
  if (!matches || !tournaments || !teams || !auth) return;

  function calculateRows() { return []; }

  function getLeaderboard(options = {}) {
    return calculateRows(options);
  }

  globalThis.ArenaLeaderboard = Object.freeze({ getLeaderboard, isAvailable: () => false });

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
    tableBody.replaceChildren();
    table.hidden = true;
    tableWrap.hidden = true;
    empty.hidden = false;
    empty.querySelector('h2').textContent = 'Leaderboard backend unavailable';
    empty.querySelector('p').textContent = 'Step 20 match responses do not provide complete player/team identities or leaderboard standings. No ranks are inferred from local data.';
    count.textContent = 'STANDINGS UNAVAILABLE';
  }

  Promise.all([tournaments.ready, matches.ready]).then(() => {
    populateFilters();
    [tournamentFilter, gameFilter, sortFilter].forEach((filter) => filter.addEventListener('change', render));
    render();
  });
  search.addEventListener('input', render);
  document.querySelector('#leaderboard-controls').addEventListener('submit', (event) => event.preventDefault());
})();
