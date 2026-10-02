(() => {
  const matches = globalThis.ArenaMatches;
  const tournaments = globalThis.ArenaTournaments;
  const auth = globalThis.ArenaAuth;
  if (!matches || !tournaments || !auth) return;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const byId = (id) => document.getElementById(id);
  const statusLabel = (status) => String(status || '').toUpperCase();
  const dateLabel = (value) => value ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`)) : 'Not scheduled';

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
    window.setTimeout(() => toast.remove(), 3600);
  }

  function getTournament(match) {
    return tournaments.getTournamentById(match.tournamentId);
  }

  function matchCard(match) {
    const tournament = getTournament(match);
    const isSolo = tournament?.type === 'Solo';
    const participantCount = Number(match.participantCount) || 0;
    return `<article class="match-record-card">
      <div class="match-record-heading"><span class="match-status status-${escapeHtml(match.status)}">${statusLabel(match.status)}</span><span class="match-number">MATCH ${String(match.matchNumber).padStart(2, '0')}</span></div>
      <p class="match-tournament-name">${escapeHtml(tournament?.name || 'Tournament unavailable')}</p>
      <h2>${escapeHtml(match.title)}</h2>
      <div class="match-record-facts"><div><span>GAME / MODE</span><strong>${escapeHtml(match.game)} · ${escapeHtml(match.mode)}</strong></div><div><span>DATE / START</span><strong>${dateLabel(match.date)} · ${escapeHtml(match.startTime)}</strong></div><div><span>MAP</span><strong>${escapeHtml(match.map || 'To be announced')}</strong></div><div><span>PARTICIPANTS</span><strong>${participantCount} / ${Number(match.maxPlayers) || 0} ${isSolo ? 'players' : 'teams'}</strong></div></div>
      <div class="match-record-actions"><a class="button button-card" href="match.html?id=${encodeURIComponent(match.matchId)}">View Match <span aria-hidden="true">↗</span></a><a class="match-tournament-link" href="tournament.html?id=${encodeURIComponent(match.tournamentId)}">Tournament details</a></div>
    </article>`;
  }

  function renderMatchList() {
    const grid = byId('match-grid');
    if (!grid) return;
    const selected = document.querySelector('[data-match-filter].is-active')?.dataset.matchFilter || 'upcoming';
    const query = (byId('match-search')?.value || '').trim().toLowerCase();
    const tournamentId = new URLSearchParams(location.search).get('tournamentId');
    const currentUser = auth.getCurrentUser();
    const empty = byId('match-empty');
    if (matches.getError()) {
      grid.hidden = true;
      empty.hidden = false;
      empty.querySelector('h2').textContent = 'Match backend unavailable';
      empty.querySelector('p').textContent = matches.getError().message;
      byId('match-result-count').textContent = 'BACKEND UNAVAILABLE';
      return;
    }
    let records = matches.getMatches();
    if (selected === 'my' && !matches.getMyMatchesAvailable()) {
      grid.hidden = true;
      empty.hidden = false;
      empty.querySelector('h2').textContent = 'Personal match list unavailable';
      empty.querySelector('p').textContent = 'The current backend API does not list a user’s match registrations.';
      byId('match-result-count').textContent = 'LIST UNAVAILABLE';
      return;
    }
    if (selected === 'my') records = matches.getMyMatches(currentUser?.userId);
    else if (selected !== 'all') records = records.filter((match) => match.status === selected);
    if (tournamentId) records = records.filter((match) => match.tournamentId === tournamentId);
    records = records.filter((match) => {
      const tournament = getTournament(match);
      return [match.title, match.game, match.mode, match.map, tournament?.name].join(' ').toLowerCase().includes(query);
    }).sort((first, second) => `${first.date} ${first.startTime}`.localeCompare(`${second.date} ${second.startTime}`));
    grid.innerHTML = records.map(matchCard).join('');
    grid.hidden = records.length === 0;
    empty.hidden = records.length !== 0;
    const emptyLabels = { upcoming: 'No upcoming matches', live: 'No live matches', completed: 'No completed matches', cancelled: 'No cancelled matches', my: 'No matches for your tournaments', all: 'No matches found' };
    empty.querySelector('h2').textContent = query ? 'No matches found.' : emptyLabels[selected];
    byId('match-result-count').textContent = `${String(records.length).padStart(2, '0')} MATCH${records.length === 1 ? '' : 'ES'}`;
  }

  function renderCreateForm() {
    const section = byId('match-organizer');
    if (!section) return;
    section.hidden = !matches.isOrganizer();
    const select = byId('new-match-tournament');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Select a tournament</option>' + tournaments.getTournaments().map((tournament) => `<option value="${escapeHtml(tournament.id)}">${escapeHtml(tournament.name)}</option>`).join('');
    if (current) select.value = current;
  }

  function fillTournamentDefaults(select) {
    const tournament = tournaments.getTournamentById(select.value);
    const form = select.form;
    if (!tournament || !form) return;
    form.elements.namedItem('game').value = tournament.game;
    form.elements.namedItem('mode').value = tournament.mode;
    form.elements.namedItem('maxPlayers').value = String(tournament.maxSlots);
  }

  function participantChoices(match, selectedIds = []) {
    return '<p class="match-editor-empty">Participant registrations are not listed by the current backend API. New matches include all active tournament registrations unless selected IDs are supplied through an authorized workflow.</p>';
  }

  function resultParticipantId(match) { return match.results?.[0]?.playerId || match.results?.[0]?.teamId || ''; }

  function renderMatchEditor(match) {
    if (!matches.isOrganizer()) return '';
    const firstResult = match.results?.[0] || {};
    const participantType = firstResult.playerId ? 'player' : 'team';
    return `<section class="match-editor-section"><div class="team-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> ORGANIZER</p><h2>Update <span>match.</span></h2></div></div>
      <form class="match-editor-form" id="match-editor-form">
        <label>Date<input name="date" type="date" value="${escapeHtml(match.date)}" required></label><label>Start time<input name="startTime" type="text" maxlength="40" value="${escapeHtml(match.startTime)}" required></label>
        <label>Map<input name="map" type="text" maxlength="60" value="${escapeHtml(match.map)}"></label><label>Status<select name="status">${['upcoming', 'live', 'completed', 'cancelled'].map((status) => `<option value="${status}" ${match.status === status ? 'selected' : ''}>${statusLabel(status)}</option>`).join('')}</select></label>
        <label>Room ID<input name="roomId" type="text" maxlength="80" value="" autocomplete="off"></label><label>Room password<input name="roomPassword" type="password" maxlength="80" value="" autocomplete="new-password"></label>
        <label>Maximum players / teams<input name="maxPlayers" type="number" min="1" step="1" value="${Number(match.maxPlayers) || 1}" required></label><label class="match-checkbox-label"><input name="roomVisible" type="checkbox" ${match.roomVisible ? 'checked' : ''}> Show room details to players</label>
        <label class="match-editor-wide">Instructions<textarea name="instructions" maxlength="1000" rows="3">${escapeHtml(match.instructions || '')}</textarea></label>
        <fieldset class="match-editor-wide"><legend>Registered participants</legend>${participantChoices()}</fieldset>
        <label>Result status<select name="resultStatus"><option value="">Do not submit result</option>${['submitted', 'published'].map((status) => `<option value="${status}" ${match.resultStatus === status ? 'selected' : ''}>${statusLabel(status)}</option>`).join('')}</select></label>
        <label>Result participant type<select name="participantType"><option value="player" ${participantType === 'player' ? 'selected' : ''}>Player</option><option value="team" ${participantType === 'team' ? 'selected' : ''}>Team</option></select></label>
        <label class="match-editor-wide">Result participant ID<input name="participantId" value="${escapeHtml(resultParticipantId(match))}" placeholder="Backend user or team ID"></label>
        <label>Placement<input name="placement" type="number" min="0" step="1" value="${Number(firstResult.placement) || ''}"></label><label>Points<input name="points" type="number" min="0" step="1" value="${Number(firstResult.points) || ''}"></label><label>Kills<input name="kills" type="number" min="0" step="1" value="${Number(firstResult.kills) || ''}"></label>
        <label class="match-editor-wide">Result remarks<textarea name="remarks" maxlength="500" rows="2">${escapeHtml(firstResult.remarks || '')}</textarea></label>
        <div class="match-editor-wide"><button class="button button-primary" type="submit">Save Match Update <span aria-hidden="true">↗</span></button></div>
      </form></section>`;
  }

  function renderParticipants(match) {
    return `<li class="match-detail-empty">${Number(match.participantCount) || 0} registrations are assigned. Individual roster details are not included in the current backend match response.</li>`;
  }

  function renderRoom(match) {
    if (!['upcoming', 'live'].includes(match.status)) return '';
    return '<button class="button button-outline" type="button" data-show-room-details>Request Room Details</button><div class="room-credentials" id="room-credentials" hidden></div>';
  }

  async function renderMatchDetail() {
    const content = byId('match-detail-content');
    if (!content) return;
    const matchId = new URLSearchParams(location.search).get('id');
    const loading = byId('match-detail-loading');
    const notFound = byId('match-not-found');
    let match = null;
    let loadError = null;
    if (matchId) {
      try { match = await matches.loadMatch(matchId); } catch (error) { loadError = error; }
    }
    loading.hidden = true;
    if (!match) {
      notFound.hidden = false;
      content.hidden = true;
      if (loadError && loadError.code !== 'NOT_FOUND') {
        notFound.querySelector('h1').textContent = 'Match backend unavailable';
        notFound.querySelector('p').textContent = loadError.message;
      }
      return;
    }
    const tournament = getTournament(match);
    document.title = `${match.title} | ARENA X`;
    notFound.hidden = true;
    content.hidden = false;
    const results = (match.results || []).length ? `<section class="match-detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> RESULT / ${escapeHtml(statusLabel(match.resultStatus))}</p><h2>Match <span>results.</span></h2><div class="match-result-row">${match.results.map((result) => `<article><strong>${escapeHtml(result.winnerName || 'Participant')}</strong><span>${result.placement ? `Place ${Number(result.placement)}` : 'Placement pending'}</span><span>${Number(result.points) || 0} points · ${Number(result.kills) || 0} kills</span><p>${escapeHtml(result.remarks || '')}</p></article>`).join('')}</div></section>` : '';
    content.innerHTML = `<a class="detail-back-link" href="matches.html"><span aria-hidden="true">←</span> All matches</a>
      <section class="match-detail-hero"><div><p class="eyebrow"><span class="eyebrow-line"></span> MATCH ${String(match.matchNumber).padStart(2, '0')} / ${escapeHtml(match.game)}</p><h1>${escapeHtml(match.title)}</h1><p class="match-detail-tournament"><a href="tournament.html?id=${encodeURIComponent(match.tournamentId)}">${escapeHtml(tournament?.name || 'Tournament unavailable')} ↗</a></p></div><span class="match-status status-${escapeHtml(match.status)}">${statusLabel(match.status)}</span></section>
      <section class="match-detail-overview"><div><span>MODE</span><strong>${escapeHtml(match.mode)}</strong></div><div><span>DATE</span><strong>${dateLabel(match.date)}</strong></div><div><span>START TIME</span><strong>${escapeHtml(match.startTime)}</strong></div><div><span>MAP</span><strong>${escapeHtml(match.map || 'To be announced')}</strong></div></section>
      <div class="match-detail-layout"><div class="match-detail-primary"><section class="match-detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> TOURNAMENT / ${escapeHtml(tournament?.type || 'EVENT')}</p><h2>Competition <span>brief.</span></h2><p>${escapeHtml(tournament?.description || 'Tournament details are unavailable.')}</p><div class="match-detail-links"><a class="button button-outline" href="tournament.html?id=${encodeURIComponent(match.tournamentId)}">Tournament details <span aria-hidden="true">↗</span></a><a class="match-tournament-link" href="matches.html">Back to all matches</a></div></section>
        <section class="match-detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> MATCH ROSTER</p><h2>Participants <span>(${Number(match.participantCount) || 0})</span></h2><ul class="match-participant-list">${renderParticipants(match)}</ul></section>
        <section class="match-detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> MATCH BRIEF</p><h2>Instructions</h2><p>${escapeHtml(match.instructions || 'Follow the tournament organizer’s instructions before joining the room.')}</p></section>
        ${results}</div><aside class="match-detail-sidebar"><section class="match-detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> PRIVATE LOBBY</p><h2>Room <span>details.</span></h2>${renderRoom(match)}</section><section class="match-detail-section"><p class="eyebrow"><span class="eyebrow-line"></span> TOURNAMENT FORMAT</p><h2>${escapeHtml(tournament?.type || 'Tournament')}</h2><div class="detail-sidebar-row"><span>Game</span><strong>${escapeHtml(tournament?.game || match.game)}</strong></div><div class="detail-sidebar-row"><span>Mode</span><strong>${escapeHtml(tournament?.mode || match.mode)}</strong></div></section></aside></div>
      ${renderMatchEditor(match)}<p class="match-demo-note">Match access and organizer actions are checked by the backend.</p>`;
  }

  async function handleCreateMatch(event) {
    event.preventDefault();
    const form = event.target;
    const values = Object.fromEntries(new FormData(form).entries());
    const result = await matches.createMatch(values);
    if (!result.success) {
      showToast(result.message, true);
      return;
    }
    form.reset();
    renderCreateForm();
    renderMatchList();
    showToast('Match created on the backend.');
  }

  async function handleUpdateMatch(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    const matchId = new URLSearchParams(location.search).get('id');
    const result = await matches.updateMatch(matchId, {
      date: formData.get('date'),
      startTime: formData.get('startTime'),
      map: formData.get('map'),
      status: formData.get('status'),
      ...(formData.get('roomId') ? { roomId: formData.get('roomId') } : {}),
      ...(formData.get('roomPassword') ? { roomPassword: formData.get('roomPassword') } : {}),
      roomVisible: formData.has('roomVisible'),
      maxPlayers: formData.get('maxPlayers'),
      instructions: formData.get('instructions')
    });
    if (!result.success) {
      showToast(result.message, true);
      return;
    }
    const participantId = String(formData.get('participantId') || '').trim();
    if (participantId) {
      const type = formData.get('participantType');
      const submitted = await matches.submitMatchResult(matchId, {
        status: formData.get('resultStatus') || 'published',
        ...(type === 'player' ? { playerId: participantId } : { teamId: participantId }),
        placement: formData.get('placement') || 0,
        points: formData.get('points') || 0,
        kills: formData.get('kills') || 0,
        remarks: formData.get('remarks')
      });
      if (!submitted.success) {
        showToast(submitted.message, true);
        await renderMatchDetail();
        return;
      }
    }
    renderMatchDetail();
    showToast('Match update saved on the backend.');
  }

  document.addEventListener('click', async (event) => {
    const filter = event.target.closest('[data-match-filter]');
    if (filter) {
      document.querySelectorAll('[data-match-filter]').forEach((button) => {
        const selected = button === filter;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      renderMatchList();
    }
    if (event.target.closest('[data-show-room-details]')) {
      const matchId = new URLSearchParams(location.search).get('id');
      const credentials = byId('room-credentials');
      const trigger = event.target.closest('[data-show-room-details]');
      trigger.disabled = true;
      const room = await matches.getRoomCredentials(matchId);
      if (room?.error) {
        showToast(room.error, true);
        trigger.disabled = false;
        return;
      }
      if (!room || !credentials) return;
      credentials.innerHTML = `<div><span>ROOM ID</span><strong>${escapeHtml(room.roomId || 'Not provided')}</strong></div><div><span>ROOM PASSWORD</span><strong>${escapeHtml(room.roomPassword || 'Not provided')}</strong></div>`;
      credentials.hidden = false;
      event.target.closest('[data-show-room-details]').hidden = true;
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.matches('#match-search')) renderMatchList();
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('#new-match-tournament')) fillTournamentDefaults(event.target);
  });
  document.addEventListener('submit', (event) => {
    if (event.target.matches('#match-create-form')) handleCreateMatch(event);
    if (event.target.matches('#match-editor-form')) handleUpdateMatch(event);
  });

  Promise.all([matches.ready, tournaments.ready, globalThis.ArenaTeams?.ready, auth.ready]).then(async () => {
    renderCreateForm();
    if (document.body.dataset.page === 'matches') renderMatchList();
    if (document.body.dataset.page === 'match-detail') await renderMatchDetail();
  });
})();