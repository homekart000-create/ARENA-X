(() => {
  const store = globalThis.ArenaTournaments;
  const auth = globalThis.ArenaAuth;
  if (!store || !auth) return;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const bannerName = (value) => String(value || 'ember').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`;
  const dateLabel = (value) => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
  const deadlineLabel = (value) => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  const detailsUrl = (id) => `tournament.html?id=${encodeURIComponent(id)}`;
  let activeMyCategory = 'All';
  let pendingJoinId = null;
  let joinDialog = null;

  function startTimestamp(tournament) {
    const time = /^(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*IST)?$/i.exec(tournament.startTime.trim());
    if (!time) return Number.MAX_SAFE_INTEGER;
    let hour = Number(time[1]) % 12;
    if (time[3].toUpperCase() === 'PM') hour += 12;
    return new Date(`${tournament.startDate}T${String(hour).padStart(2, '0')}:${time[2]}:00`).getTime();
  }

  function showToast(message, isError = false) {
    let region = document.querySelector('.toast-region');
    if (!region) {
      region = document.createElement('div');
      region.className = 'toast-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.append(region);
    }
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' is-error' : ''}`;
    toast.textContent = message;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 3800);
  }

  function registrationStatus(tournament, registration) {
    const status = String(registration?.status || 'registered').toLowerCase();
    if (status === 'cancelled') return 'CANCELLED';
    if (tournament.status === 'Live') return 'LIVE';
    if (tournament.status === 'Completed') return 'COMPLETED';
    return 'REGISTERED';
  }

  function tournamentCard(tournament, index = 0, joinedLabel = false) {
    const joined = store.isTournamentJoined(tournament.id);
    const registration = store.getRegistration(tournament.id);
    const full = tournament.joinedSlots >= tournament.maxSlots;
    const closed = tournament.status === 'Completed' || Date.now() > new Date(tournament.registrationDeadline).getTime();
    const joinLabel = joined ? 'Joined' : closed ? 'Closed' : full ? 'Full' : 'Join';
    const statusClass = `status-${String(tournament.status).toLowerCase()}`;
    const registeredStatus = registrationStatus(tournament, registration);
    const registrationClass = `registration-${registeredStatus.toLowerCase()}`;
    const registrationLabel = registeredStatus === 'LIVE' ? 'LIVE NOW' : registeredStatus;
    const percent = Math.min(100, Math.round((tournament.joinedSlots / tournament.maxSlots) * 100));
    const joinControl = joinedLabel
      ? `<span class="registration-status-badge ${registrationClass}">✓ ${registrationLabel}</span>`
      : joined
        ? `<button class="button button-join" type="button" data-tournament-cancel="${escapeHtml(tournament.id)}">Cancel registration</button>`
        : `<button class="button button-join" type="button" data-tournament-join="${escapeHtml(tournament.id)}">${joinLabel}</button>`;
    return `<article class="tournament-card tournament-card-rich" style="animation-delay:${Math.min(index, 8) * 45}ms">
      <a class="tournament-card-banner tournament-banner-${bannerName(tournament.banner)}" href="${detailsUrl(tournament.id)}" aria-label="View ${escapeHtml(tournament.name)} details"><span class="tournament-banner-kicker">${escapeHtml(tournament.game)} / ARENA X EVENT</span><span class="card-status ${statusClass}">${escapeHtml(tournament.status.toUpperCase())}</span><span class="tournament-banner-index">AX / ${String(index + 1).padStart(2, '0')}</span></a>
      <div class="tournament-card-body"><div class="tournament-card-title"><h2>${escapeHtml(tournament.name)}</h2><span class="type-badge">${escapeHtml(tournament.type)}</span></div><p class="tournament-game-name">${escapeHtml(tournament.game)} <span>·</span> ${escapeHtml(tournament.mode)}</p>
      <div class="card-prizes"><div><small>PRIZE POOL</small><strong>${money(tournament.prizePool)}</strong></div><div><small>ENTRY FEE</small><strong class="entry-value">${tournament.entryFee ? money(tournament.entryFee) : 'FREE'}</strong></div></div>
      <div class="tournament-card-meta"><span>${dateLabel(tournament.startDate)}</span><span>${escapeHtml(tournament.startTime)}</span><span>${tournament.joinedSlots} / ${tournament.maxSlots} slots</span><span>Available: ${store.getAvailableSlots(tournament)}</span></div>
      <div class="slots-track" role="progressbar" aria-label="Tournament slots" aria-valuemin="0" aria-valuemax="${tournament.maxSlots}" aria-valuenow="${tournament.joinedSlots}"><span style="width:${percent}%"></span></div>
      ${joinedLabel ? `<div class="registration-summary"><span class="team-status">TEAM: ${registration?.teamId ? 'ASSIGNED' : 'NOT ASSIGNED'}</span><span>Backend registration</span></div>` : ''}
      <div class="card-actions"><a class="button button-card" href="${detailsUrl(tournament.id)}">View tournament</a>${joinControl}</div></div>
    </article>`;
  }

  function ensureJoinDialog() {
    if (joinDialog) return joinDialog;
    joinDialog = document.createElement('dialog');
    joinDialog.id = 'join-confirm-dialog';
    joinDialog.className = 'join-dialog';
    joinDialog.setAttribute('aria-labelledby', 'join-confirm-title');
    joinDialog.innerHTML = `<button class="dialog-close" type="button" aria-label="Close confirmation" data-join-cancel>×</button>
      <div class="join-dialog-content"><p class="eyebrow"><span class="eyebrow-line"></span> ARENA X / CONFIRM ENTRY</p><h2 id="join-confirm-title">Join Tournament</h2>
      <div class="join-dialog-facts"><div><span>TOURNAMENT</span><strong data-confirm-name></strong></div><div><span>GAME / TYPE</span><strong data-confirm-game></strong></div><div><span>DATE / TIME</span><strong data-confirm-start></strong></div><div><span>ENTRY FEE</span><strong data-confirm-fee></strong></div><div><span>PRIZE POOL</span><strong data-confirm-prize></strong></div><div><span>AVAILABLE SLOTS</span><strong data-confirm-slots></strong></div></div>
      <p class="demo-payment-note" data-confirm-payment hidden>Entry-fee collection is unavailable until an atomic wallet settlement endpoint is provided.</p>
      <p class="join-dialog-copy" data-join-copy>Confirm to submit your registration to ARENA X.</p>
      <div class="join-dialog-actions"><button class="button button-outline" type="button" data-join-cancel>Cancel</button><button class="button button-primary" type="button" data-join-confirm><span data-confirm-label>Confirm Registration</span><span aria-hidden="true">↗</span></button></div></div>`;
    document.body.append(joinDialog);
    joinDialog.addEventListener('click', (event) => {
      if (event.target === joinDialog || event.target.closest('[data-join-cancel]')) joinDialog.close();
      if (event.target.closest('[data-join-confirm]')) confirmRegistration();
    });
    joinDialog.addEventListener('close', () => { pendingJoinId = null; });
    return joinDialog;
  }

  function openJoinDialog(tournament) {
    const dialog = ensureJoinDialog();
    pendingJoinId = tournament.id;
    dialog.querySelector('[data-confirm-name]').textContent = tournament.name;
    dialog.querySelector('[data-confirm-game]').textContent = `${tournament.game} / ${tournament.type}`;
    dialog.querySelector('[data-confirm-start]').textContent = `${dateLabel(tournament.startDate)} / ${tournament.startTime}`;
    dialog.querySelector('[data-confirm-fee]').textContent = tournament.entryFee ? money(tournament.entryFee) : 'FREE';
    dialog.querySelector('[data-confirm-prize]').textContent = money(tournament.prizePool);
    dialog.querySelector('[data-confirm-slots]').textContent = String(store.getAvailableSlots(tournament));
    const paidEntryUnavailable = tournament.entryFee > 0;
    dialog.querySelector('[data-confirm-payment]').hidden = !paidEntryUnavailable;
    dialog.querySelector('[data-join-copy]').textContent = paidEntryUnavailable
      ? 'This paid tournament cannot accept registrations until entry-fee settlement is supported.'
      : 'Confirm to submit your registration to ARENA X.';
    const confirmButton = dialog.querySelector('[data-join-confirm]');
    confirmButton.disabled = paidEntryUnavailable;
    confirmButton.classList.remove('is-loading');
    dialog.querySelector('[data-confirm-label]').textContent = paidEntryUnavailable ? 'Registration unavailable' : 'Confirm Registration';
    dialog.showModal();
  }

  async function refreshTournamentViews() {
    if (document.body.dataset.page === 'home' || document.body.dataset.page === 'tournaments') await store.loadTournaments();
    if (document.body.dataset.page === 'home') globalThis.ArenaHomeRefresh?.();
    if (document.body.dataset.page === 'tournaments') renderTournamentList();
    if (document.body.dataset.page === 'tournament-detail') await renderTournamentDetail();
    if (document.body.dataset.page === 'my-tournaments') renderMyTournaments();
  }

  async function confirmRegistration() {
    if (!pendingJoinId) return;
    const tournament = store.getTournamentById(pendingJoinId);
    if (tournament?.entryFee > 0) {
      showToast('Paid registration is unavailable until backend wallet settlement is supported.', true);
      return;
    }
    const confirmButton = joinDialog.querySelector('[data-join-confirm]');
    confirmButton.disabled = true;
    confirmButton.classList.add('is-loading');
    joinDialog.querySelector('[data-confirm-label]').textContent = 'Registering...';
    const team = tournament?.type === 'Solo' ? null : globalThis.ArenaTeams?.getUserTeam();
    const result = await store.joinTournament(pendingJoinId, { ...(team ? { teamId: team.teamId } : {}) });
    if (!result.success) {
      joinDialog.close();
      pendingJoinId = null;
      showToast(result.message, true);
      await refreshTournamentViews();
      return;
    }
    joinDialog.close();
    pendingJoinId = null;
    await refreshTournamentViews();
    showToast(`Registration successful! You have joined ${result.tournament?.name || 'this tournament'}.`);
  }

  function renderTournamentList() {
    const grid = document.querySelector('#tournament-grid');
    if (!grid) return;
    const loading = document.querySelector('#tournament-loading');
    const count = document.querySelector('#tournament-result-count');
    const empty = document.querySelector('#tournament-empty');
    const search = document.querySelector('#tournament-search')?.value.trim().toLowerCase() || '';
    const game = document.querySelector('#filter-game')?.value || 'All Games';
    const status = document.querySelector('#filter-status')?.value || 'All';
    const type = document.querySelector('#filter-type')?.value || 'All';
    const entry = document.querySelector('#filter-entry')?.value || 'All';
    const sort = document.querySelector('#sort-tournaments')?.value || 'starting-soon';
    const loadError = store.getError();
    if (loadError) {
      grid.hidden = true;
      loading.hidden = true;
      empty.hidden = false;
      empty.querySelector('h2').textContent = 'Tournament backend unavailable';
      empty.querySelector('p').textContent = loadError.message;
      if (count) count.textContent = 'BACKEND UNAVAILABLE';
      return;
    }
    const filtered = store.getTournaments().filter((tournament) => {
      const searchText = [tournament.name, tournament.game, tournament.host, tournament.type, tournament.description].join(' ').toLowerCase();
      return (!search || searchText.includes(search))
        && (game === 'All Games' || tournament.game === game)
        && (status === 'All' || tournament.status === status)
        && (type === 'All' || tournament.type === type)
        && (entry === 'All' || (entry === 'Free' ? tournament.entryFee === 0 : tournament.entryFee > 0));
    });
    const sorters = {
      'starting-soon': (first, second) => {
        const order = { Upcoming: 0, Live: 1, Completed: 2 };
        const statusDifference = (order[first.status] ?? 3) - (order[second.status] ?? 3);
        return statusDifference || startTimestamp(first) - startTimestamp(second);
      },
      'prize-pool': (first, second) => second.prizePool - first.prizePool,
      'most-players': (first, second) => second.joinedSlots - first.joinedSlots,
      newest: (first, second) => new Date(second.createdAt) - new Date(first.createdAt)
    };
    filtered.sort(sorters[sort] || sorters['starting-soon']);
    grid.innerHTML = filtered.map((tournament, index) => tournamentCard(tournament, index)).join('');
    grid.hidden = filtered.length === 0;
    empty.hidden = filtered.length !== 0;
    loading.hidden = true;
    if (count) count.textContent = `${String(filtered.length).padStart(2, '0')} TOURNAMENT${filtered.length === 1 ? '' : 'S'}`;
  }

  async function renderTournamentDetail() {
    const content = document.querySelector('#tournament-detail-content');
    if (!content) return;
    const loading = document.querySelector('#tournament-loading');
    const notFound = document.querySelector('#tournament-not-found');
    const id = new URLSearchParams(location.search).get('id');
    let tournament = null;
    let loadError = null;
    if (id) {
      try { tournament = await store.loadTournament(id); } catch (error) { loadError = error; }
    }
    loading.hidden = true;
    if (!tournament) {
      content.hidden = true;
      notFound.hidden = false;
      if (loadError && loadError.code !== 'NOT_FOUND') {
        notFound.querySelector('h1').textContent = 'Competition backend unavailable.';
        notFound.querySelector('p:last-of-type').textContent = loadError.message;
      }
      document.title = 'Tournament not found | ARENA X';
      return;
    }
    notFound.hidden = true;
    content.hidden = false;
    document.title = `${tournament.name} | ARENA X`;
    const joined = store.isTournamentJoined(tournament.id);
    const statusClass = `status-${String(tournament.status).toLowerCase()}`;
    const availableSlots = store.getAvailableSlots(tournament);
    const deadlinePassed = Number.isNaN(new Date(tournament.registrationDeadline).getTime()) || Date.now() > new Date(tournament.registrationDeadline).getTime();
    const joinControl = joined
      ? `<span class="registration-status-badge registration-registered">✓ Registered</span><button class="button button-outline" type="button" data-tournament-cancel="${escapeHtml(tournament.id)}">Cancel registration</button>`
      : tournament.status === 'Completed'
        ? '<button class="button button-outline" type="button" disabled>Tournament Completed</button>'
        : deadlinePassed
          ? '<button class="button button-outline" type="button" disabled>Registration Closed</button>'
          : availableSlots <= 0
            ? '<button class="button button-outline" type="button" disabled>Slots Full</button>'
            : `<button class="button button-primary" type="button" data-tournament-join="${escapeHtml(tournament.id)}">${auth.isLoggedIn() ? 'Join Tournament' : 'Login to Join'} <span aria-hidden="true">↗</span></button>`;
    const prizeRows = tournament.prizeDistribution.map((prize) => `<div class="prize-row"><strong>${escapeHtml(prize.place)}</strong><span>${prize.percentage}%</span><b>${money(tournament.prizePool * prize.percentage / 100)}</b></div>`).join('');
    const rules = tournament.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('');
    const relatedMatches = globalThis.ArenaMatches?.getMatchesByTournament(tournament.id) || [];
    const matchRows = relatedMatches.map((match) => `<a class="tournament-match-row" href="match.html?id=${encodeURIComponent(match.matchId)}"><span><strong>${escapeHtml(match.title)}</strong><small>Match ${String(match.matchNumber).padStart(2, '0')} · ${dateLabel(match.date)} · ${escapeHtml(match.startTime)}</small></span><span class="match-status status-${escapeHtml(match.status)}">${escapeHtml(match.status.toUpperCase())}</span></a>`).join('');
    content.innerHTML = `<a class="detail-back-link" href="tournaments.html"><span aria-hidden="true">←</span> All tournaments</a>
      <section class="detail-hero"><div class="detail-hero-banner tournament-banner-${bannerName(tournament.banner)}"><span class="tournament-banner-kicker">${escapeHtml(tournament.game)} / ARENA X EVENT</span><span class="detail-hero-mark">AX</span><span class="card-status ${statusClass}">${escapeHtml(tournament.status.toUpperCase())}</span></div>
      <div class="detail-hero-copy"><div class="detail-hero-title"><div><p class="eyebrow"><span class="eyebrow-line"></span> ${escapeHtml(tournament.type.toUpperCase())} / ${escapeHtml(tournament.game.toUpperCase())}</p><h1>${escapeHtml(tournament.name)}</h1></div><span class="type-badge">${escapeHtml(tournament.type)}</span></div><p>${escapeHtml(tournament.description)}</p><div class="detail-hero-actions">${joinControl}</div></div></section>
      <section class="detail-overview" aria-label="Tournament overview"><div><span>ENTRY FEE</span><strong>${tournament.entryFee ? money(tournament.entryFee) : 'FREE'}</strong></div><div><span>PRIZE POOL</span><strong>${money(tournament.prizePool)}</strong></div><div><span>JOINED / MAX</span><strong>${tournament.joinedSlots} / ${tournament.maxSlots}</strong></div><div><span>AVAILABLE SLOTS</span><strong>${availableSlots}</strong></div></section>
      <div class="detail-content-grid"><div class="detail-content-primary"><section class="detail-section tournament-matches-section"><p class="eyebrow"><span class="eyebrow-line"></span> MATCH SCHEDULE</p><h2>Related <span>matches.</span></h2><div class="match-detail-links"><a class="match-tournament-link" href="matches.html?tournamentId=${encodeURIComponent(tournament.id)}">Tournament matches ↗</a><a class="match-tournament-link" href="leaderboard.html?tournamentId=${encodeURIComponent(tournament.id)}">Tournament leaderboard ↗</a></div>${matchRows ? `<div class="tournament-match-list">${matchRows}</div>` : '<p>No matches have been scheduled for this tournament yet.</p>'}</section><section class="detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> ABOUT</p><h2>Enter the <span>arena.</span></h2><p>${escapeHtml(tournament.description)}</p></section>
      <section class="detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> RULES</p><h2>Play it <span>clean.</span></h2><ul class="tournament-rules">${rules}</ul></section>
      <section class="detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> PRIZE DISTRIBUTION</p><h2>Play for the <span>podium.</span></h2><div class="prize-distribution">${prizeRows}</div></section></div>
      <aside class="detail-sidebar"><section class="detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> MATCH FORMAT</p><h2>Format</h2><div class="detail-sidebar-row"><span>Game</span><strong>${escapeHtml(tournament.game)}</strong></div><div class="detail-sidebar-row"><span>Team type</span><strong>${escapeHtml(tournament.type)}</strong></div><div class="detail-sidebar-row"><span>Map</span><strong>${escapeHtml(tournament.map)}</strong></div><div class="detail-sidebar-row"><span>Mode</span><strong>${escapeHtml(tournament.mode)}</strong></div></section>
      <section class="detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> TOURNAMENT INFORMATION</p><h2>Event <span>brief.</span></h2><div class="detail-sidebar-row"><span>Start date</span><strong>${dateLabel(tournament.startDate)}</strong></div><div class="detail-sidebar-row"><span>Start time</span><strong>${escapeHtml(tournament.startTime)}</strong></div><div class="detail-sidebar-row"><span>Registration closes</span><strong>${deadlineLabel(tournament.registrationDeadline)}</strong></div><div class="detail-sidebar-row"><span>Host</span><strong>${escapeHtml(tournament.host)}</strong></div></section></aside></div>`;
    if (store.getPendingTournament() === tournament.id) store.clearPendingTournament(tournament.id);
  }

  function renderMyTournaments() {
    const content = document.querySelector('#my-tournament-groups');
    if (!content || !auth.isLoggedIn()) return;
    const loading = document.querySelector('#my-tournament-loading');
    const empty = document.querySelector('#my-tournament-empty');
    const filterEmpty = document.querySelector('#my-filter-empty');
    if (!store.getMyTournamentsAvailable()) {
      loading.hidden = true;
      content.hidden = true;
      filterEmpty.hidden = true;
      empty.hidden = false;
      empty.querySelector('h2').textContent = 'Registration list unavailable';
      empty.querySelector('p').textContent = 'The current backend API can register and cancel entries, but cannot list your registrations yet.';
      empty.querySelector('a').hidden = true;
      return;
    }
    const joined = store.getMyTournaments();
    const visibleEntries = activeMyCategory === 'All' ? joined : joined.filter((tournament) => tournament.status === activeMyCategory);
    loading.hidden = true;
    empty.hidden = joined.length > 0;
    filterEmpty.hidden = joined.length === 0 || activeMyCategory === 'All' || visibleEntries.length > 0;
    content.hidden = joined.length === 0 || visibleEntries.length === 0;
    document.querySelectorAll('[data-my-tab]').forEach((tab) => {
      const selected = tab.dataset.myTab === activeMyCategory;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    ['Upcoming', 'Live', 'Completed'].forEach((category) => {
      const entries = joined.filter((tournament) => tournament.status === category);
      const section = content.querySelector(`[data-category="${category}"]`);
      const list = content.querySelector(`[data-category-list="${category}"]`);
      const count = content.querySelector(`[data-category-count="${category}"]`);
      section.hidden = entries.length === 0 || (activeMyCategory !== 'All' && activeMyCategory !== category);
      list.innerHTML = entries.map((tournament, index) => tournamentCard(tournament, index, true)).join('');
      count.textContent = `${String(entries.length).padStart(2, '0')} EVENT${entries.length === 1 ? '' : 'S'}`;
    });
  }

  function handleJoin(tournamentId) {
    const tournament = store.getTournamentById(tournamentId);
    if (!tournament) {
      showToast('This tournament could not be found.', true);
      return;
    }
    if (store.isTournamentJoined(tournamentId)) {
      showToast('Already registered. Open My Tournaments to view your entry.', true);
      refreshTournamentViews();
      return;
    }
    if (!auth.isLoggedIn()) {
      if (!store.savePendingTournament(tournamentId)) {
        showToast('This tournament could not be saved for your return after login.', true);
        return;
      }
      auth.saveReturnTarget(detailsUrl(tournamentId));
      auth.saveNotice('Log in is required to join this tournament.', 'info');
      location.assign('login.html');
      return;
    }
    const validation = store.validateTournamentJoin(tournamentId);
    if (!validation.valid) {
      showToast(validation.message, true);
      refreshTournamentViews();
      return;
    }
    openJoinDialog(tournament);
  }

  async function handleCancel(tournamentId, button) {
    button.disabled = true;
    const result = await store.cancelRegistration(tournamentId);
    if (!result.success) showToast(result.message || 'Registration could not be cancelled.', true);
    else showToast('Registration cancelled.');
    await refreshTournamentViews();
  }

  document.addEventListener('click', (event) => {
    const joinButton = event.target.closest('[data-tournament-join]');
    if (joinButton) handleJoin(joinButton.dataset.tournamentJoin);
    const cancelButton = event.target.closest('[data-tournament-cancel]');
    if (cancelButton) handleCancel(cancelButton.dataset.tournamentCancel, cancelButton);
    const tab = event.target.closest('[data-my-tab]');
    if (tab) {
      activeMyCategory = tab.dataset.myTab;
      renderMyTournaments();
    }
  });
  document.querySelector('#tournament-filters')?.addEventListener('input', renderTournamentList);
  document.querySelector('#tournament-filters')?.addEventListener('change', renderTournamentList);
  document.querySelector('#tournament-filters')?.addEventListener('reset', () => window.setTimeout(renderTournamentList, 0));

  Promise.all([store.ready, globalThis.ArenaTeams?.ready, globalThis.ArenaMatches?.ready, auth.ready]).then(async () => {
    if (document.body.dataset.page === 'tournaments') renderTournamentList();
    if (document.body.dataset.page === 'tournament-detail') await renderTournamentDetail();
    if (document.body.dataset.page === 'my-tournaments' && !auth.isLoggedIn()) return;
    if (document.body.dataset.page === 'my-tournaments') renderMyTournaments();
    const sessionNotice = auth.consumeNotice();
    if (sessionNotice) showToast(sessionNotice.message, sessionNotice.type === 'error');
  });
})();
