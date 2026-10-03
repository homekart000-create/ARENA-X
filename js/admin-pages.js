(() => {
  const auth = globalThis.ArenaAuth;
  const admin = globalThis.ArenaAdmin;
  if (!auth || !admin || document.body.dataset.page !== 'admin') return;

  auth.ready.then(async () => {
    await Promise.all([globalThis.ArenaTournaments?.ready, globalThis.ArenaTeams?.ready, globalThis.ArenaMatches?.ready]);
    if (!await auth.requireAdmin()) return;
    initializeAdminPage();
  });

  function initializeAdminPage() {
  const user = auth.getCurrentUser();
  const app = document.querySelector('#admin-app');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const dateLabel = (value) => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not recorded';
  const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const localDateTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    const part = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
  };

  function showNotice(message, isError = false) {
    const region = document.querySelector('#admin-message');
    region.textContent = message;
    region.classList.toggle('is-error', isError);
    region.hidden = false;
    window.setTimeout(() => { region.hidden = true; }, 3200);
  }

  function renderSummary() {
    const summary = admin.getSummary();
    Object.entries(summary).forEach(([key, value]) => {
      const target = document.querySelector(`[data-admin-stat="${key}"]`);
      if (target) target.textContent = value === null ? '—' : key === 'totalWalletBalance' ? money(value) : Number(value).toLocaleString('en-IN');
    });
  }

  function renderUsers() {
    if (admin.getUsers() === null) {
      document.querySelector('#admin-users-body').innerHTML = '';
      document.querySelector('#admin-users-body').closest('table').hidden = true;
      document.querySelector('#admin-users-empty').hidden = true;
      document.querySelector('#admin-users-unavailable').hidden = false;
      document.querySelector('#admin-users .admin-filter-bar').hidden = true;
      document.querySelector('#admin-users-count').textContent = 'UNAVAILABLE';
      return;
    }
    const search = document.querySelector('#admin-user-search').value.trim().toLowerCase();
    const role = document.querySelector('#admin-user-role').value;
    const status = document.querySelector('#admin-user-status').value;
    const filtered = admin.getUsers().filter((entry) => {
      const text = [entry.username, entry.fullName, entry.email].join(' ').toLowerCase();
      return (!search || text.includes(search)) && (role === 'all' || entry.role === role) && (status === 'all' || entry.status === status);
    });
    const body = document.querySelector('#admin-users-body');
    body.innerHTML = filtered.map((entry) => `<tr><td><strong>${escapeHtml(entry.username)}</strong><small>${escapeHtml(entry.fullName)}</small></td><td>${escapeHtml(entry.email)}</td><td><span class="admin-role-badge ${entry.role === 'admin' ? 'is-admin' : ''}">${escapeHtml(entry.role.toUpperCase())}</span></td><td><span class="admin-status-badge status-${escapeHtml(entry.status)}">${escapeHtml(entry.status.toUpperCase())}</span></td><td>${escapeHtml(dateLabel(entry.createdAt))}</td><td>${entry.userId === user.userId ? '<span class="admin-self-label">CURRENT ADMIN</span>' : `<button class="button button-outline admin-action-button" type="button" data-admin-action="user-status" data-user-id="${escapeHtml(entry.userId)}" data-next-status="${entry.status === 'active' ? 'suspended' : 'active'}">${entry.status === 'active' ? 'Suspend' : 'Reactivate'}</button>`}</td></tr>`).join('');
    body.closest('table').hidden = filtered.length === 0;
    document.querySelector('#admin-users-empty').hidden = filtered.length !== 0;
    document.querySelector('#admin-users-unavailable').hidden = true;
    document.querySelector('#admin-users .admin-filter-bar').hidden = false;
    document.querySelector('#admin-users-count').textContent = `${filtered.length} USERS`;
  }

  function renderTournaments() {
    const search = document.querySelector('#admin-tournament-search').value.trim().toLowerCase();
    const game = document.querySelector('#admin-tournament-game').value;
    const status = document.querySelector('#admin-tournament-status').value;
    const filtered = admin.getTournaments().filter((entry) => [entry.name, entry.game, entry.host].join(' ').toLowerCase().includes(search)
      && (game === 'all' || entry.game === game)
      && (status === 'all' || String(entry.status).toLowerCase() === status));
    const games = [...new Set(admin.getTournaments().map((entry) => entry.game).filter(Boolean))].sort();
    const gameSelect = document.querySelector('#admin-tournament-game');
    const selectedGame = gameSelect.value;
    gameSelect.innerHTML = '<option value="all">All Games</option>' + games.map((entry) => `<option value="${escapeHtml(entry)}">${escapeHtml(entry)}</option>`).join('');
    gameSelect.value = games.includes(selectedGame) ? selectedGame : 'all';
    const body = document.querySelector('#admin-tournaments-body');
    body.innerHTML = filtered.map((entry) => `<tr><td><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.type)} · ${escapeHtml(entry.mode)}</small></td><td>${escapeHtml(entry.game)}</td><td>${escapeHtml(money(entry.entryFee))}</td><td>${escapeHtml(money(entry.prizePool))}</td><td>${Number(entry.joinedSlots) || 0} / ${Number(entry.maxSlots) || 0}</td><td>${escapeHtml(dateLabel(entry.startDate))} · ${escapeHtml(entry.startTime)}</td><td><div class="admin-inline-form"><select data-tournament-status="${escapeHtml(entry.id)}" aria-label="Status for ${escapeHtml(entry.name)}">${['draft', 'upcoming', 'live', 'completed', 'cancelled'].map((value) => `<option value="${value}" ${String(entry.status).toLowerCase() === value ? 'selected' : ''}>${value.toUpperCase()}</option>`).join('')}</select><button class="button button-outline admin-action-button" type="button" data-save-tournament-status="${escapeHtml(entry.id)}">Status</button><button class="button button-outline admin-action-button" type="button" data-load-tournament-participants="${escapeHtml(entry.id)}">Players</button><a class="admin-table-link" href="tournament.html?id=${encodeURIComponent(entry.id)}">View</a><details class="admin-operations"><summary>Edit details</summary><form class="match-editor-form" data-admin-tournament-edit data-id="${escapeHtml(entry.id)}"><label>Name<input name="name" value="${escapeHtml(entry.name)}" required maxlength="120"></label><label>Game<input name="game" value="${escapeHtml(entry.game)}" required maxlength="60"></label><label>Format<select name="type">${['Solo', 'Duo', 'Squad'].map((value) => `<option ${entry.type === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Mode<input name="mode" value="${escapeHtml(entry.mode)}" required maxlength="100"></label><label>Entry fee<input name="entryFee" type="number" min="0" step="0.01" value="${Number(entry.entryFee)}" required></label><label>Prize pool<input name="prizePool" type="number" min="0" step="0.01" value="${Number(entry.prizePool)}" required></label><label>Slots<input name="maxSlots" type="number" min="1" step="1" value="${Number(entry.maxSlots)}" required></label><label>Host<input name="host" value="${escapeHtml(entry.host)}" maxlength="120"></label><label>Starts at<input name="startsAt" type="datetime-local" value="${localDateTime(entry.startsAt)}" required></label><label>Registration deadline<input name="registrationDeadline" type="datetime-local" value="${localDateTime(entry.registrationDeadline)}" required></label><label>Map<input name="map" value="${escapeHtml(entry.map)}" maxlength="80"></label><label>Banner key<input name="banner" value="${escapeHtml(entry.banner)}" maxlength="80"></label><label class="match-editor-wide">Description<textarea name="description" maxlength="5000">${escapeHtml(entry.description)}</textarea></label><div class="match-editor-wide"><button class="button button-primary" type="submit">Save tournament details</button></div></form></details></div><div data-tournament-participants="${escapeHtml(entry.id)}" hidden></div></td></tr>`).join('');
    body.closest('table').hidden = filtered.length === 0;
    document.querySelector('#admin-tournaments-empty').hidden = filtered.length !== 0;
    document.querySelector('#admin-tournaments-count').textContent = `${filtered.length} TOURNAMENTS`;
  }

  function renderTeams() {
    const search = document.querySelector('#admin-team-search').value.trim().toLowerCase();
    const filtered = admin.getTeams().filter((entry) => [entry.teamName, entry.teamTag, entry.ownerName, ...entry.members.map((member) => member.username)].join(' ').toLowerCase().includes(search));
    const body = document.querySelector('#admin-teams-body');
    body.innerHTML = filtered.map((entry) => `<tr><td><strong>${escapeHtml(entry.teamName)} [${escapeHtml(entry.teamTag)}]</strong><small>${escapeHtml(entry.status || 'active')}</small></td><td>${escapeHtml(entry.ownerName)}</td><td>${entry.memberCount} members${entry.members.length ? `<details class="admin-member-details"><summary>View members</summary><span>${entry.members.map((member) => escapeHtml(`${member.username} (${member.role})`)).join(', ')}</span></details>` : ''}</td><td>${Number(entry.stats?.tournamentsJoined) || 0} tournaments · ${Number(entry.stats?.wins) || 0} wins</td><td>${escapeHtml(dateLabel(entry.createdAt))}</td><td><a class="admin-table-link" href="team.html?id=${encodeURIComponent(entry.teamId)}">View team</a></td></tr>`).join('');
    body.closest('table').hidden = filtered.length === 0;
    document.querySelector('#admin-teams-empty').hidden = filtered.length !== 0;
    document.querySelector('#admin-teams-count').textContent = `${filtered.length} TEAMS`;
  }

  function renderMatches() {
    const search = document.querySelector('#admin-match-search').value.trim().toLowerCase();
    const status = document.querySelector('#admin-match-status').value;
    const filtered = admin.getMatches().filter((entry) => [entry.title, entry.tournamentName, entry.game, entry.mode].join(' ').toLowerCase().includes(search)
      && (status === 'all' || entry.status === status));
    const body = document.querySelector('#admin-matches-body');
    body.innerHTML = filtered.map((entry) => `<tr><td><strong>${escapeHtml(entry.title)}</strong><small>Match ${String(entry.matchNumber).padStart(2, '0')} · ${escapeHtml(entry.tournamentName)}</small></td><td>${escapeHtml(entry.game)} · ${escapeHtml(entry.mode)}</td><td>${escapeHtml(dateLabel(entry.date))} · ${escapeHtml(entry.startTime)}</td><td>${entry.participantCount}</td><td>${entry.roomVisible ? 'PUBLISHED' : 'NOT PUBLISHED'}</td><td><button class="button button-outline admin-action-button" type="button" data-load-match-operations="${escapeHtml(entry.matchId)}">Manage</button><a class="admin-table-link" href="match.html?id=${encodeURIComponent(entry.matchId)}">View</a><div data-match-operations="${escapeHtml(entry.matchId)}" hidden></div></td></tr>`).join('');
    body.closest('table').hidden = filtered.length === 0;
    document.querySelector('#admin-matches-empty').hidden = filtered.length !== 0;
    document.querySelector('#admin-matches-count').textContent = `${filtered.length} MATCHES`;
    const tournamentSelect = document.querySelector('#admin-match-tournament');
    if (tournamentSelect) {
      const selectedTournament = tournamentSelect.value;
      tournamentSelect.innerHTML = '<option value="">Select a tournament</option>' + admin.getTournaments().filter((entry) => String(entry.status).toLowerCase() !== 'draft').map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.name)} · ${escapeHtml(entry.status)}</option>`).join('');
      tournamentSelect.value = selectedTournament;
    }
  }

  function participantLabel(registration) {
    const players = registration.players.map((player) => player.username).join(', ');
    return registration.teamName ? `${registration.teamName} — ${players}` : players;
  }

  async function loadTournamentParticipants(tournamentId) {
    const target = [...document.querySelectorAll('[data-tournament-participants]')].find((element) => element.dataset.tournamentParticipants === tournamentId);
    if (!target) return;
    target.hidden = false;
    target.textContent = 'Loading registrations…';
    const result = await admin.getTournamentParticipants(tournamentId);
    if (!result.success) {
      target.textContent = result.message;
      return;
    }
    target.innerHTML = result.registrations.length
      ? `<ul class="admin-participant-list">${result.registrations.map((registration) => `<li>${escapeHtml(participantLabel(registration))}</li>`).join('')}</ul>`
      : '<p>No active registrations.</p>';
  }

  function matchOperationsMarkup(matchId, participants) {
    const match = admin.getMatches().find((entry) => entry.matchId === matchId);
    if (!match) return '<p>Match is no longer available. Refresh the admin panel.</p>';
    const choices = participants.flatMap((registration) => {
      if (registration.teamId) return [`<option value="team:${escapeHtml(registration.teamId)}">${escapeHtml(participantLabel(registration))}</option>`];
      return registration.players.map((player) => `<option value="player:${escapeHtml(player.userId)}">${escapeHtml(player.username)}</option>`);
    }).join('');
    const assignmentOptions = participants.map((registration) => `<label><input type="checkbox" name="registrationIds" value="${escapeHtml(registration.registrationId)}" checked>${escapeHtml(participantLabel(registration))}</label>`).join('');
    return `<section class="admin-match-operations"><ul class="admin-participant-list">${participants.map((registration) => `<li>${escapeHtml(participantLabel(registration))}</li>`).join('') || '<li>No active participants assigned.</li>'}</ul>
      <form class="match-editor-form" data-admin-match-operations-form data-id="${escapeHtml(matchId)}">
        <fieldset class="match-editor-wide"><legend>Registered participants assigned to this match</legend>${assignmentOptions || '<p>No active tournament registrations.</p>'}</fieldset>
        <label>Title<input name="title" value="${escapeHtml(match.title)}" required maxlength="80"></label><label>Game<input name="game" value="${escapeHtml(match.game)}" required maxlength="60"></label>
        <label>Match type / mode<input name="mode" value="${escapeHtml(match.mode)}" required maxlength="80"></label><label>Scheduled at<input name="startsAt" type="datetime-local" value="${localDateTime(match.startsAt)}" required></label>
        <label>Status<select name="status">${['upcoming', 'live', 'completed', 'cancelled'].map((status) => `<option value="${status}" ${match.status === status ? 'selected' : ''}>${status.toUpperCase()}</option>`).join('')}</select></label>
        <label>Maximum registrations<input name="maxPlayers" type="number" min="1" step="1" value="${Number(match.maxPlayers)}" required></label>
        <label>Map<input name="map" value="${escapeHtml(match.map)}" maxlength="80"></label>
        <label>Room ID<input name="roomId" maxlength="80" autocomplete="off" value=""></label>
        <label>Room password<input name="roomPassword" type="password" maxlength="80" autocomplete="new-password" value=""></label>
        <label class="match-editor-wide">Instructions<textarea name="instructions" maxlength="1000">${escapeHtml(match.instructions || '')}</textarea></label>
        <fieldset class="match-editor-wide admin-result-entries"><legend>Results / placements</legend><div data-result-entries><div class="admin-result-entry"><label>Participant<select name="resultParticipant"><option value="">Skip this row</option>${choices}</select></label><label>Placement<input name="placement" type="number" min="0" step="1"></label><label>Points<input name="points" type="number" min="0" step="1"></label><label>Kills<input name="kills" type="number" min="0" step="1"></label><label>Remarks<input name="remarks" maxlength="500"></label><button class="button button-outline admin-action-button" type="button" data-remove-result-entry>Remove</button></div></div><button class="button button-outline admin-action-button" type="button" data-add-result-entry>Add participant result</button></fieldset>
        <label>Result status<select name="resultStatus"><option value="published">Publish result</option><option value="submitted">Save as submitted</option></select></label>
        <div class="match-editor-wide"><button class="button button-primary" type="submit">Save match / result</button><button class="button button-outline" type="button" data-notify-match="${escapeHtml(matchId)}">Publish room & notify registered players</button></div>
      </form></section>`;
  }

  async function loadCreateMatchRegistrations(tournamentId) {
    const select = document.querySelector('#admin-match-registrations');
    if (!select) return;
    select.innerHTML = '';
    if (!tournamentId) return;
    const result = await admin.getTournamentParticipants(tournamentId);
    if (!result.success) {
      showNotice(result.message, true);
      return;
    }
    select.innerHTML = result.registrations.map((registration) => `<option value="${escapeHtml(registration.registrationId)}">${escapeHtml(participantLabel(registration))}</option>`).join('');
    const tournament = admin.getTournaments().find((entry) => entry.id === tournamentId);
    const form = document.querySelector('#admin-match-create-form');
    if (tournament && form) {
      form.elements.namedItem('game').value = tournament.game;
      form.elements.namedItem('mode').value = tournament.mode;
      form.elements.namedItem('maxPlayers').value = String(tournament.maxSlots);
    }
  }

  function renderTransactions() {
    if (admin.getWalletTransactions() === null) {
      document.querySelector('#admin-transactions-body').innerHTML = '';
      document.querySelector('#admin-transactions-body').closest('table').hidden = true;
      document.querySelector('#admin-transactions-empty').hidden = true;
      document.querySelector('#admin-wallet-unavailable').hidden = false;
      document.querySelector('#admin-transactions .admin-filter-bar').hidden = true;
      document.querySelector('#admin-transactions-count').textContent = 'UNAVAILABLE';
      return;
    }
    const search = document.querySelector('#admin-transaction-search').value.trim().toLowerCase();
    const type = document.querySelector('#admin-transaction-type').value;
    const status = document.querySelector('#admin-transaction-status').value;
    const userId = document.querySelector('#admin-transaction-user').value;
    const filtered = admin.getWalletTransactions().filter((entry) => [entry.id, entry.username, entry.description, entry.referenceId].join(' ').toLowerCase().includes(search)
      && (type === 'all' || entry.type === type)
      && (status === 'all' || entry.status === status)
      && (userId === 'all' || entry.userId === userId));
    const userSelect = document.querySelector('#admin-transaction-user');
    const selectedUser = userSelect.value;
    const users = auth.getUsers();
    userSelect.innerHTML = '<option value="all">All Users</option>' + users.map((entry) => `<option value="${escapeHtml(entry.userId)}">${escapeHtml(entry.username)}</option>`).join('');
    userSelect.value = users.some((entry) => entry.userId === selectedUser) ? selectedUser : 'all';
    const body = document.querySelector('#admin-transactions-body');
    body.innerHTML = filtered.map((entry) => `<tr><td><strong>${escapeHtml(entry.id)}</strong><small>${escapeHtml(entry.username)}</small></td><td>${escapeHtml(entry.type.replaceAll('_', ' ').toUpperCase())}</td><td>${escapeHtml(money(entry.amount))}</td><td><span class="admin-status-badge status-${escapeHtml(entry.status)}">${escapeHtml(entry.status.toUpperCase())}</span></td><td>${escapeHtml(entry.description)}</td><td>${escapeHtml(entry.referenceId || '—')}</td><td>${escapeHtml(dateLabel(entry.createdAt))}</td></tr>`).join('');
    body.closest('table').hidden = filtered.length === 0;
    document.querySelector('#admin-transactions-empty').hidden = filtered.length !== 0;
    document.querySelector('#admin-wallet-unavailable').hidden = true;
    document.querySelector('#admin-transactions .admin-filter-bar').hidden = false;
    document.querySelector('#admin-transactions-count').textContent = `${filtered.length} TRANSACTIONS`;
  }

  function renderAudit() {
    const activity = admin.getAdminActivity().filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      && typeof entry.action === 'string' && typeof entry.description === 'string'
      && typeof entry.targetType === 'string' && typeof entry.targetId === 'string'
      && typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)));
    const list = document.querySelector('#admin-audit-list');
    list.innerHTML = activity.slice(0, 40).map((entry) => `<article class="admin-audit-row"><span class="admin-audit-action">${escapeHtml(entry.action.replaceAll('_', ' ').toUpperCase())}</span><strong>${escapeHtml(entry.description)}</strong><span>${escapeHtml(entry.targetType)} · ${escapeHtml(entry.targetId)}</span><time>${escapeHtml(dateLabel(entry.timestamp))}</time></article>`).join('');
    list.hidden = activity.length === 0;
    document.querySelector('#admin-audit-empty').hidden = activity.length !== 0;
  }

  function renderAll() {
    renderSummary();
    renderUsers();
    renderTournaments();
    renderTeams();
    renderMatches();
    renderTransactions();
    renderAudit();
  }

  document.addEventListener('input', (event) => {
    if (event.target.matches('#admin-user-search')) renderUsers();
    if (event.target.matches('#admin-tournament-search')) renderTournaments();
    if (event.target.matches('#admin-team-search')) renderTeams();
    if (event.target.matches('#admin-match-search')) renderMatches();
    if (event.target.matches('#admin-transaction-search')) renderTransactions();
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('#admin-user-role, #admin-user-status')) renderUsers();
    if (event.target.matches('#admin-tournament-game, #admin-tournament-status')) renderTournaments();
    if (event.target.matches('#admin-match-status')) renderMatches();
    if (event.target.matches('#admin-transaction-type, #admin-transaction-status, #admin-transaction-user')) renderTransactions();
    if (event.target.matches('#admin-match-tournament')) loadCreateMatchRegistrations(event.target.value);
  });
  document.addEventListener('click', async (event) => {
    const addResultEntry = event.target.closest('[data-add-result-entry]');
    if (addResultEntry) {
      const entries = addResultEntry.closest('fieldset').querySelector('[data-result-entries]');
      const row = entries.querySelector('.admin-result-entry').cloneNode(true);
      row.querySelectorAll('select, input').forEach((field) => { field.value = ''; });
      entries.append(row);
      return;
    }
    const removeResultEntry = event.target.closest('[data-remove-result-entry]');
    if (removeResultEntry) {
      const entries = removeResultEntry.closest('[data-result-entries]');
      if (entries.querySelectorAll('.admin-result-entry').length > 1) removeResultEntry.closest('.admin-result-entry').remove();
      return;
    }
    const saveTournamentStatus = event.target.closest('[data-save-tournament-status]');
    if (saveTournamentStatus) {
      const tournamentId = saveTournamentStatus.dataset.saveTournamentStatus;
      const status = document.querySelector(`[data-tournament-status="${tournamentId}"]`).value;
      const result = await admin.setTournamentStatus(tournamentId, status);
      showNotice(result.success ? 'Tournament status updated.' : result.message, !result.success);
      await globalThis.ArenaTournaments.loadTournaments();
      renderAll();
      return;
    }
    const tournamentParticipants = event.target.closest('[data-load-tournament-participants]');
    if (tournamentParticipants) {
      await loadTournamentParticipants(tournamentParticipants.dataset.loadTournamentParticipants);
      return;
    }
    const matchOperations = event.target.closest('[data-load-match-operations]');
    if (matchOperations) {
      const target = [...document.querySelectorAll('[data-match-operations]')].find((element) => element.dataset.matchOperations === matchOperations.dataset.loadMatchOperations);
      if (!target) return;
      target.hidden = false;
      target.textContent = 'Loading registered participants…';
      const result = await admin.getMatchParticipants(matchOperations.dataset.loadMatchOperations);
      if (!result.success) {
        target.textContent = result.message;
        return;
      }
      target.innerHTML = matchOperationsMarkup(matchOperations.dataset.loadMatchOperations, result.participants);
      return;
    }
    const notifyMatch = event.target.closest('[data-notify-match]');
    if (notifyMatch) {
      notifyMatch.disabled = true;
      const result = await admin.notifyMatchPlayers(notifyMatch.dataset.notifyMatch);
      showNotice(result.success
        ? `Room access published; ${result.notified} new notification(s) sent to registered players.`
        : result.message, !result.success);
      await globalThis.ArenaMatches.loadMatches();
      renderAll();
    }
  });
  document.addEventListener('submit', async (event) => {
    const tournamentCreateForm = event.target.closest('#admin-tournament-create-form');
    if (tournamentCreateForm) {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(tournamentCreateForm).entries());
      const result = await admin.createTournament({
        ...data,
        entryFee: Number(data.entryFee),
        prizePool: Number(data.prizePool),
        maxSlots: Number(data.maxSlots),
        startsAt: new Date(data.startsAt).toISOString(),
        registrationDeadline: new Date(data.registrationDeadline).toISOString()
      });
      showNotice(result.success ? 'Tournament created.' : result.message, !result.success);
      if (result.success) {
        tournamentCreateForm.reset();
        await globalThis.ArenaTournaments.loadTournaments();
        renderAll();
      }
      renderAll();
      return;
    }
    const tournamentEditForm = event.target.closest('[data-admin-tournament-edit]');
    if (tournamentEditForm) {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(tournamentEditForm).entries());
      const result = await admin.updateTournament(tournamentEditForm.dataset.id, {
        ...data,
        entryFee: Number(data.entryFee),
        prizePool: Number(data.prizePool),
        maxSlots: Number(data.maxSlots),
        startsAt: new Date(data.startsAt).toISOString(),
        registrationDeadline: new Date(data.registrationDeadline).toISOString()
      });
      showNotice(result.success ? 'Tournament details updated.' : result.message, !result.success);
      if (result.success) {
        await globalThis.ArenaTournaments.loadTournaments();
        renderAll();
      }
      return;
    }
    const matchCreateForm = event.target.closest('#admin-match-create-form');
    if (matchCreateForm) {
      event.preventDefault();
      const formData = new FormData(matchCreateForm);
      const selectedRegistrationIds = formData.getAll('registrationIds');
      const result = await admin.createMatch({
        ...Object.fromEntries(formData.entries()),
        matchNumber: Number(formData.get('matchNumber')),
        maxPlayers: Number(formData.get('maxPlayers')),
        ...(selectedRegistrationIds.length ? { registrationIds: selectedRegistrationIds } : {})
      });
      showNotice(result.success ? 'Match created.' : result.message, !result.success);
      if (result.success) {
        matchCreateForm.reset();
        await globalThis.ArenaMatches.loadMatches();
        renderAll();
      }
      return;
    }
    const matchForm = event.target.closest('[data-admin-match-operations-form]');
    if (matchForm) {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(matchForm).entries());
      const matchId = matchForm.dataset.id;
      const resultEntries = [...matchForm.querySelectorAll('.admin-result-entry')].flatMap((row) => {
        const [type, participantId] = row.querySelector('[name="resultParticipant"]').value.split(':', 2);
        if (!participantId) return [];
        const values = Object.fromEntries([...row.querySelectorAll('input')].map((field) => [field.name, field.value]));
        return [{ type, participantId, ...values }];
      });
      if (resultEntries.some((entry) => ['placement', 'points', 'kills'].some((field) => entry[field] === ''))) {
        showNotice('Enter placement, points, and kills for every selected result participant.', true);
        return;
      }
      const update = await admin.updateMatch(matchId, {
        title: data.title,
        game: data.game,
        mode: data.mode,
        startsAt: new Date(data.startsAt).toISOString(),
        status: data.status,
        maxPlayers: Number(data.maxPlayers),
        map: data.map,
        instructions: data.instructions,
        roomId: data.roomId,
        roomPassword: data.roomPassword,
        registrationIds: new FormData(matchForm).getAll('registrationIds')
      });
      if (!update.success) {
        showNotice(update.message, true);
        return;
      }
      if (resultEntries.length) {
        const result = await admin.submitMatchResult(matchId, {
          status: data.resultStatus,
          entries: resultEntries.map((entry) => ({
            ...(entry.type === 'team' ? { teamId: entry.participantId } : { playerId: entry.participantId }),
            placement: Number(entry.placement),
            points: Number(entry.points),
            kills: Number(entry.kills),
            remarks: entry.remarks
          }))
        });
        if (!result.success) {
          showNotice(result.message, true);
          await globalThis.ArenaMatches.loadMatches();
          renderAll();
          return;
        }
      }
      showNotice(resultEntries.length ? 'Match details and results saved.' : 'Match details saved.');
      await globalThis.ArenaMatches.loadMatches();
      renderAll();
      return;
    }
  });

  app.hidden = false;
  document.documentElement.style.visibility = '';
  renderAll();
  }
})();