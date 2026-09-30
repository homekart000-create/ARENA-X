(() => {
  const auth = globalThis.ArenaAuth;
  const admin = globalThis.ArenaAdmin;
  if (!auth || !admin || document.body.dataset.page !== 'admin' || !auth.requireAdmin()) return;

  const user = auth.getCurrentUser();
  const app = document.querySelector('#admin-app');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const dateLabel = (value) => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not recorded';
  const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
      if (target) target.textContent = key === 'totalWalletBalance' ? money(value) : Number(value).toLocaleString('en-IN');
    });
  }

  function renderUsers() {
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
    document.querySelector('#admin-users-count').textContent = `${filtered.length} USERS`;
  }

  function renderTournaments() {
    const search = document.querySelector('#admin-tournament-search').value.trim().toLowerCase();
    const game = document.querySelector('#admin-tournament-game').value;
    const status = document.querySelector('#admin-tournament-status').value;
    const filtered = admin.getTournaments().filter((entry) => [entry.name, entry.game, entry.host].join(' ').toLowerCase().includes(search)
      && (game === 'all' || entry.game === game)
      && (status === 'all' || entry.status === status));
    const games = [...new Set(admin.getTournaments().map((entry) => entry.game).filter(Boolean))].sort();
    const gameSelect = document.querySelector('#admin-tournament-game');
    const selectedGame = gameSelect.value;
    gameSelect.innerHTML = '<option value="all">All Games</option>' + games.map((entry) => `<option value="${escapeHtml(entry)}">${escapeHtml(entry)}</option>`).join('');
    gameSelect.value = games.includes(selectedGame) ? selectedGame : 'all';
    const body = document.querySelector('#admin-tournaments-body');
    body.innerHTML = filtered.map((entry) => `<tr><td><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.type)} · ${escapeHtml(entry.mode)}</small></td><td>${escapeHtml(entry.game)}</td><td>${escapeHtml(money(entry.entryFee))}</td><td>${escapeHtml(money(entry.prizePool))}</td><td>${Number(entry.joinedSlots) || 0} / ${Number(entry.maxSlots) || 0}</td><td>${escapeHtml(dateLabel(entry.startDate))} · ${escapeHtml(entry.startTime)}</td><td><form class="admin-inline-form" data-admin-tournament-form data-id="${escapeHtml(entry.id)}"><select name="status" aria-label="Status for ${escapeHtml(entry.name)}">${['Upcoming', 'Live', 'Completed'].map((value) => `<option value="${value}" ${entry.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select><button class="button button-outline admin-action-button" type="submit">Save</button><a class="admin-table-link" href="tournament.html?id=${encodeURIComponent(entry.id)}">View</a></form></td></tr>`).join('');
    body.closest('table').hidden = filtered.length === 0;
    document.querySelector('#admin-tournaments-empty').hidden = filtered.length !== 0;
    document.querySelector('#admin-tournaments-count').textContent = `${filtered.length} TOURNAMENTS`;
  }

  function renderTeams() {
    const search = document.querySelector('#admin-team-search').value.trim().toLowerCase();
    const filtered = admin.getTeams().filter((entry) => [entry.teamName, entry.teamTag, entry.ownerName, ...entry.members.map((member) => member.username)].join(' ').toLowerCase().includes(search));
    const body = document.querySelector('#admin-teams-body');
    body.innerHTML = filtered.map((entry) => `<tr><td><strong>${escapeHtml(entry.teamName)} [${escapeHtml(entry.teamTag)}]</strong><small>${escapeHtml(entry.status || 'active')}</small></td><td>${escapeHtml(entry.ownerName)}</td><td>${entry.memberCount} / 4${entry.members.length ? `<details class="admin-member-details"><summary>View members</summary><span>${entry.members.map((member) => escapeHtml(`${member.username} (${member.role})`)).join(', ')}</span></details>` : ''}</td><td>${Number(entry.stats?.tournamentsJoined) || 0} tournaments · ${Number(entry.stats?.wins) || 0} wins</td><td>${escapeHtml(dateLabel(entry.createdAt))}</td><td><a class="admin-table-link" href="team.html?id=${encodeURIComponent(entry.teamId)}">View team</a></td></tr>`).join('');
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
    body.innerHTML = filtered.map((entry) => `<tr><td><strong>${escapeHtml(entry.title)}</strong><small>Match ${String(entry.matchNumber).padStart(2, '0')} · ${escapeHtml(entry.tournamentName)}</small></td><td>${escapeHtml(entry.game)} · ${escapeHtml(entry.mode)}</td><td>${escapeHtml(dateLabel(entry.date))} · ${escapeHtml(entry.startTime)}</td><td>${entry.participantCount}</td><td>${entry.roomVisible ? 'VISIBLE TO PLAYERS' : 'HIDDEN'}</td><td><form class="admin-inline-form" data-admin-match-form data-id="${escapeHtml(entry.matchId)}"><select name="status" aria-label="Status for ${escapeHtml(entry.title)}">${['upcoming', 'live', 'completed', 'cancelled'].map((value) => `<option value="${value}" ${entry.status === value ? 'selected' : ''}>${value.toUpperCase()}</option>`).join('')}</select><details class="admin-room-editor"><summary>Room settings</summary><label>Room ID<input name="roomId" value="${escapeHtml(entry.roomId)}" maxlength="80"></label><label>Room password<input type="password" name="roomPassword" value="${escapeHtml(entry.roomPassword)}" maxlength="80" autocomplete="off"></label></details><label class="admin-visibility-toggle"><input type="checkbox" name="roomVisible" ${entry.roomVisible ? 'checked' : ''}> Room visible</label><button class="button button-outline admin-action-button" type="submit">Save</button><a class="admin-table-link" href="match.html?id=${encodeURIComponent(entry.matchId)}">View</a></form></td></tr>`).join('');
    body.closest('table').hidden = filtered.length === 0;
    document.querySelector('#admin-matches-empty').hidden = filtered.length !== 0;
    document.querySelector('#admin-matches-count').textContent = `${filtered.length} MATCHES`;
  }

  function renderTransactions() {
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

  function handleUserStatus(button) {
    const result = admin.setUserStatus(button.dataset.userId, button.dataset.nextStatus);
    showNotice(result.success ? 'User status updated.' : result.message, !result.success);
    renderAll();
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
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-admin-action="user-status"]');
    if (button) handleUserStatus(button);
  });
  document.addEventListener('submit', (event) => {
    const tournamentForm = event.target.closest('[data-admin-tournament-form]');
    if (tournamentForm) {
      event.preventDefault();
      const status = new FormData(tournamentForm).get('status');
      const result = admin.setTournamentStatus(tournamentForm.dataset.id, status);
      showNotice(result.success ? 'Tournament status updated.' : result.message, !result.success);
      renderAll();
      return;
    }
    const matchForm = event.target.closest('[data-admin-match-form]');
    if (matchForm) {
      event.preventDefault();
      const formData = new FormData(matchForm);
      const result = admin.updateMatch(matchForm.dataset.id, {
        status: formData.get('status'),
        roomId: formData.get('roomId'),
        roomPassword: formData.get('roomPassword'),
        roomVisible: formData.has('roomVisible')
      });
      showNotice(result.success ? 'Match settings updated.' : result.message, !result.success);
      renderAll();
    }
  });

  app.hidden = false;
  renderAll();
})();