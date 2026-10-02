let matches = [];
const players = [];

const tournamentGrid = document.querySelector('#tournament-grid');
const emptyState = document.querySelector('#tournament-empty');
const toastRegion = document.querySelector('#toast-region, .toast-region');
let activeHomeGame = 'Free Fire';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function homeTournamentCard(tournament, index) {
  const joined = window.ArenaTournaments.isTournamentJoined(tournament.id);
  const full = tournament.joinedSlots >= tournament.maxSlots;
  const closed = tournament.status === 'Completed' || Date.now() > new Date(tournament.registrationDeadline).getTime();
  const statusClass = `status-${tournament.status.toLowerCase()}`;
  const bannerClass = String(tournament.banner).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const date = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${tournament.startDate}T12:00:00`));
  return `<article class="tournament-card tournament-card-rich" style="animation-delay:${index * 45}ms">
    <a class="tournament-card-banner tournament-banner-${bannerClass}" href="tournament.html?id=${encodeURIComponent(tournament.id)}"><span class="tournament-banner-kicker">${escapeHtml(tournament.game)} / ARENA X EVENT</span><span class="card-status ${statusClass}">${escapeHtml(tournament.status.toUpperCase())}</span><span class="tournament-banner-index">AX / ${String(index + 1).padStart(2, '0')}</span></a>
    <div class="tournament-card-body"><div class="tournament-card-title"><h3>${escapeHtml(tournament.name)}</h3><span class="type-badge">${escapeHtml(tournament.type)}</span></div><p class="tournament-game-name">${escapeHtml(tournament.game)} <span>·</span> ${escapeHtml(tournament.mode)}</p>
    <div class="card-prizes"><div><small>PRIZE POOL</small><strong>₹${tournament.prizePool.toLocaleString('en-IN')}</strong></div><div><small>ENTRY FEE</small><strong class="entry-value">${tournament.entryFee ? `₹${tournament.entryFee}` : 'FREE'}</strong></div></div>
    <div class="tournament-card-meta"><span>${date}</span><span>${escapeHtml(tournament.startTime)}</span><span>${tournament.joinedSlots} / ${tournament.maxSlots} slots</span><span>Available: ${window.ArenaTournaments.getAvailableSlots(tournament)}</span></div>
    <div class="slots-track" role="progressbar" aria-label="Tournament slots" aria-valuemin="0" aria-valuemax="${tournament.maxSlots}" aria-valuenow="${tournament.joinedSlots}"><span style="width:${Math.min(100, Math.round(tournament.joinedSlots / tournament.maxSlots * 100))}%"></span></div>
    <div class="card-actions"><a class="button button-card" href="tournament.html?id=${encodeURIComponent(tournament.id)}">View Tournament</a>${joined ? '<a class="button button-join" href="my-tournaments.html">View My Tournament</a>' : `<button class="button button-join" type="button" data-tournament-join="${escapeHtml(tournament.id)}">${full ? 'Slots Full' : closed ? 'Registration Closed' : 'Join'}</button>`}</div></div>
  </article>`;
}

function renderTournaments(game = activeHomeGame) {
  activeHomeGame = game;
  const records = window.ArenaTournaments.getTournaments();
  const filtered = records.filter((tournament) => tournament.featured && (game === 'All Games' || tournament.game === game));
  tournamentGrid.innerHTML = filtered.map(homeTournamentCard).join('');
  tournamentGrid.hidden = filtered.length === 0;
  emptyState.hidden = filtered.length !== 0;
  const note = document.querySelector('.listing-note');
  note.innerHTML = window.ArenaTournaments.getError()
    ? '<span class="live-pulse"></span> TOURNAMENT BACKEND UNAVAILABLE'
    : `<span class="live-pulse"></span> ${String(filtered.length).padStart(2, '0')} EVENTS LISTED`;
  if (window.ArenaTournaments.getError()) {
    emptyState.querySelector('p').textContent = 'Tournament backend unavailable';
    emptyState.lastElementChild.textContent = window.ArenaTournaments.getError().message;
  }
}

function renderMatches() {
  const grid = document.querySelector('#match-grid');
  if (window.ArenaMatches.getError()) {
    grid.textContent = window.ArenaMatches.getError().message;
    return;
  }
  grid.innerHTML = matches.map((match) => {
    const first = String(match.first ?? 'TBD');
    const second = String(match.second ?? 'TBD');
    return `<article class="match-card">
    <div class="match-card-head"><span class="match-event">${escapeHtml(match.event)}</span><span class="match-live ${match.live ? '' : 'match-upcoming'}">${match.live ? '<i class="live-pulse"></i>' : ''}${escapeHtml(match.state)}</span></div>
    <div class="match-teams"><div class="match-team"><span class="team-emblem">${escapeHtml(first.slice(0, 1))}</span><strong>${escapeHtml(first)}</strong></div><span class="match-vs">${escapeHtml(match.score)}</span><div class="match-team"><span class="team-emblem">${escapeHtml(second.slice(0, 1))}</span><strong>${escapeHtml(second)}</strong></div></div>
    <div class="match-card-foot"><span>${escapeHtml(match.detail)}</span><a href="match.html?id=${encodeURIComponent(match.matchId)}">Match details ↗</a></div>
  </article>`;
  }).join('');
}

function renderPlayers() {
  if (players.length === 0) {
    document.querySelector('#leaderboard-table').textContent = 'Leaderboard data is not available from the current backend API.';
    return;
  }
  const avatarTones = ['#d2fa47', '#f58b63', '#79bbc0', '#f2c45a'];
  document.querySelector('#leaderboard-table').innerHTML = players.map((player, index) => `<div class="player-row" role="listitem"><span class="player-rank">0${index + 1}</span><div class="player-ident"><span class="player-avatar" style="--avatar-tone:${avatarTones[index % avatarTones.length]}" aria-hidden="true">${player.name.slice(0, 2).toUpperCase()}</span><span class="player-name-wrap"><strong>${player.name}</strong><span>${player.squad}</span></span></div><span class="player-metric"><strong>${player.wins}</strong><span>WINS</span></span><span class="player-metric"><strong>${player.kills}</strong><span>KILLS</span></span><span class="player-metric"><strong>${player.points.toLocaleString('en-IN')}</strong><span>POINTS</span></span></div>`).join('');
}

function renderFeaturedSpotlight() {
  const tournament = window.ArenaTournaments.getTournaments().find((entry) => entry.featured);
  if (!tournament) {
    document.querySelector('#hero-tournament-name').textContent = window.ArenaTournaments.getError() ? 'Tournament backend unavailable' : 'No featured tournament';
    document.querySelector('#hero-tournament-prize').textContent = '—';
    document.querySelector('#hero-tournament-start').textContent = '—';
    document.querySelector('#hero-tournament-link').href = 'tournaments.html';
    return;
  }
  document.querySelector('#hero-tournament-name').textContent = tournament.name;
  document.querySelector('#hero-tournament-prize').textContent = `₹${tournament.prizePool.toLocaleString('en-IN')}`;
  document.querySelector('#hero-tournament-start').textContent = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(`${tournament.startDate}T12:00:00`));
  document.querySelector('#hero-tournament-link').href = `tournament.html?id=${encodeURIComponent(tournament.id)}`;
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' is-error' : ''}`;
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3400);
}

document.addEventListener('click', (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    const { action, event: eventName } = actionTarget.dataset;
    if (action === 'match-info') {
      showToast(`${eventName}: live match information is sample data for this preview.`);
    }
  }

  const filter = event.target.closest('[data-filter]');
  if (filter) {
    document.querySelectorAll('[data-filter]').forEach((button) => {
      const selected = button === filter;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    renderTournaments(filter.dataset.filter);
  }

  const gameTile = event.target.closest('[data-game]');
  if (gameTile) {
    const game = gameTile.dataset.game;
    document.querySelectorAll('[data-game]').forEach((tile) => tile.classList.toggle('is-featured', tile === gameTile));
    const matchingFilter = document.querySelector(`[data-filter="${CSS.escape(game)}"]`);
    if (matchingFilter) matchingFilter.click();
    else showToast(`${game} events will appear here when that competition circuit is active.`);
  }

});

window.ArenaHomeRefresh = () => renderTournaments(activeHomeGame);

Promise.all([window.ArenaTournaments.ready, window.ArenaMatches.ready]).then(() => {
  matches = window.ArenaMatches.getMatches().slice(0, 4).map((match) => {
    const status = String(match.status || 'upcoming').toLowerCase();
    const date = new Date(`${String(match.date || '')}T12:00:00`);
    const dateLabel = Number.isNaN(date.getTime())
      ? 'DATE TBD'
      : new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(date);
    return {
      matchId: match.matchId,
      event: match.title || 'Match details pending',
      state: status === 'live' ? 'LIVE NOW' : status === 'upcoming' ? 'UP NEXT' : status.toUpperCase(),
      live: status === 'live',
      first: 'REGISTERED',
      second: `${Number(match.participantCount) || 0} ENTRIES`,
      score: dateLabel,
      detail: `${match.game} / ${match.mode}`
    };
  });
  renderFeaturedSpotlight();
  renderTournaments();
  renderMatches();
  renderPlayers();
});

const authNotice = window.ArenaAuth?.consumeNotice();
if (authNotice) showToast(authNotice.message, authNotice.type === 'error');
