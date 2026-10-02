(() => {
  const teams = globalThis.ArenaTeams;
  const auth = globalThis.ArenaAuth;
  const tournamentStore = globalThis.ArenaTournaments;
  if (!teams || !auth) return;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date pending' : new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  };
  const dateLabel = formatDate;
  let teamDialog;
  let pendingConfirmation = null;

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

  function ensureTeamDialog() {
    if (teamDialog) return teamDialog;
    teamDialog = document.createElement('dialog');
    teamDialog.className = 'team-dialog';
    teamDialog.id = 'team-dialog';
    teamDialog.setAttribute('aria-labelledby', 'team-dialog-title');
    teamDialog.innerHTML = '<button class="dialog-close" type="button" aria-label="Close dialog" data-team-cancel>×</button><div class="team-dialog-content" id="team-dialog-content"></div>';
    document.body.append(teamDialog);
    teamDialog.addEventListener('click', (event) => {
      if (event.target === teamDialog || event.target.closest('[data-team-cancel]')) {
        teamDialog.close();
        pendingConfirmation = null;
      }
      if (event.target.closest('[data-team-confirm]')) runPendingConfirmation();
    });
    teamDialog.addEventListener('close', () => { pendingConfirmation = null; });
    return teamDialog;
  }

  function openTeamForm(mode, team = null) {
    const dialog = ensureTeamDialog();
    const editing = mode === 'edit';
    const content = dialog.querySelector('#team-dialog-content');
    content.innerHTML = `<p class="eyebrow"><span class="eyebrow-line"></span> ${editing ? 'TEAM SETTINGS' : 'NEW ROSTER'}</p><h2 id="team-dialog-title">${editing ? 'Edit Team' : 'Create a Team'}</h2><p class="team-dialog-intro">${editing ? 'Keep your team identity current.' : 'Choose a name your squad can stand behind.'}</p>
      <form class="team-form" id="team-form" data-mode="${mode}" novalidate>
        <label>Team name<input name="teamName" type="text" minlength="3" maxlength="32" value="${escapeHtml(team?.teamName || '')}" placeholder="Example: Nightfall Esports" required><small class="team-field-error" data-team-error="teamName"></small></label>
        <label>Team tag<input name="teamTag" type="text" minlength="2" maxlength="6" value="${escapeHtml(team?.teamTag || '')}" placeholder="NFX" required><small class="team-field-error" data-team-error="teamTag"></small></label>
        <label>Team logo / avatar<input name="logo" type="text" maxlength="80" value="${escapeHtml(team?.logo || '')}" placeholder="2-4 letter mark, e.g. NFX"><small>Use a short mark or emoji-style initials.</small></label>
        <label>Team description<textarea name="description" maxlength="240" rows="3" placeholder="What does your team play for?">${escapeHtml(team?.description || '')}</textarea></label>
        <p class="team-form-message" data-team-message role="alert"></p>
        <div class="team-dialog-actions"><button class="button button-outline" type="button" data-team-cancel>Cancel</button><button class="button button-primary" type="submit"><span data-team-submit>${editing ? 'Save Changes' : 'Create Team'}</span><span aria-hidden="true">↗</span></button></div>
      </form>`;
    dialog.showModal();
  }

  function openConfirmation(title, message, label, callback) {
    const dialog = ensureTeamDialog();
    pendingConfirmation = callback;
    dialog.querySelector('#team-dialog-content').innerHTML = `<p class="eyebrow"><span class="eyebrow-line"></span> CONFIRM TEAM CHANGE</p><h2 id="team-dialog-title">${escapeHtml(title)}</h2><p class="team-dialog-intro">${escapeHtml(message)}</p><div class="team-dialog-actions"><button class="button button-outline" type="button" data-team-cancel>Cancel</button><button class="button button-primary" type="button" data-team-confirm>${escapeHtml(label)} <span aria-hidden="true">↗</span></button></div>`;
    dialog.showModal();
  }

  async function runPendingConfirmation() {
    if (!pendingConfirmation) return;
    const action = pendingConfirmation;
    pendingConfirmation = null;
    const result = await action();
    teamDialog.close();
    if (!result.success) {
      showToast(result.message, true);
      return;
    }
    showToast(result.message || 'Team updated.');
    renderTeamPage();
  }

  function renderInvitations() {
    const list = document.querySelector('#team-invitations-list');
    if (!list) return;
    if (!teams.areInvitationListsAvailable()) {
      list.textContent = 'The current backend API does not provide an invitation inbox or invitation list.';
      return;
    }
    const invitations = teams.getUserInvitations();
    list.innerHTML = invitations.length ? invitations.map((invitation) => {
      const sender = auth.getUserById(invitation.senderId);
      return `<article class="team-invitation-card"><div><span class="team-invitation-tag">INVITATION</span><h3>${escapeHtml(invitation.teamName)}</h3><p>From ${escapeHtml(sender?.username || 'ARENA X player')} · ${formatDate(invitation.createdAt)}</p></div><div class="team-invitation-actions"><button class="button button-outline" type="button" data-team-action="decline-invite" data-id="${escapeHtml(invitation.invitationId)}">Decline</button><button class="button button-primary" type="button" data-team-action="accept-invite" data-id="${escapeHtml(invitation.invitationId)}">Accept</button></div></article>`;
    }).join('') : '<p class="team-invitation-empty">No pending team invitations.</p>';
  }

  function renderTeamDashboard(team) {
    const currentUser = auth.getCurrentUser();
    const isCaptain = team.ownerId === currentUser.userId;
    const members = team.members || [];
    const memberCards = members.map((member) => `<article class="team-member-card"><span class="team-member-avatar">${escapeHtml(member.avatar || member.username.slice(0, 2).toUpperCase())}</span><div class="team-member-identity"><strong>${escapeHtml(member.username)}</strong><span>${escapeHtml(member.fullName)}</span><small>Joined ${formatDate(member.joinedAt)}</small></div><span class="team-role-badge ${member.role === 'CAPTAIN' ? 'is-captain' : ''}">${escapeHtml(member.role)}</span>${isCaptain && member.userId !== team.ownerId ? `<button class="team-icon-action" type="button" aria-label="Remove ${escapeHtml(member.username)}" data-team-action="remove-member" data-user-id="${escapeHtml(member.userId)}">×</button>` : ''}</article>`).join('');
    const invitationMarkup = isCaptain ? `<section class="team-panel"><div class="team-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> ROSTER MANAGEMENT</p><h2>Invite <span>players.</span></h2></div></div><form class="team-invite-form" data-team-invite-form="${escapeHtml(team.teamId)}"><label for="team-invite-username">Username</label><div><input id="team-invite-username" name="username" type="text" autocomplete="off" placeholder="Search by username"><button class="button button-primary" type="submit">Send invite <span aria-hidden="true">↗</span></button></div><p class="team-invite-result" aria-live="polite"></p></form><p class="team-invitation-empty">Invitation lists are not available from the current backend API.</p></section>` : '';
    const unavailable = '<p class="team-invitation-empty">Not available from the current backend API.</p>';
    return `<section class="team-overview-panel"><div class="team-cover tournament-banner-${escapeHtml(team.logo || 'ember')}"><span class="team-avatar-large">${escapeHtml(team.logo || team.teamTag.slice(0, 3))}</span><span class="team-cover-stamp">TEAM / ${escapeHtml(team.teamTag)}</span></div><div class="team-overview-copy"><div><p class="eyebrow"><span class="eyebrow-line"></span> ${isCaptain ? 'CAPTAIN' : 'MEMBER'} / ACTIVE ROSTER</p><h2>${escapeHtml(team.teamName)} <span>[${escapeHtml(team.teamTag)}]</span></h2><p>${escapeHtml(team.description || 'Ready for the next battle.')}</p></div>${isCaptain ? '<div class="team-overview-actions"><button class="button button-outline" type="button" data-team-action="edit">Edit Team</button><button class="button button-primary" type="button" data-team-action="invite">Invite Player <span aria-hidden="true">↗</span></button></div>' : ''}</div></section>
      <section class="team-stats-grid" aria-label="Team statistics"><div><strong>—</strong><span>TOURNAMENTS JOINED</span></div><div><strong>—</strong><span>WINS</span></div><div><strong>—</strong><span>MATCHES</span></div><div><strong>—</strong><span>KILLS</span></div><div><strong>—</strong><span>POINTS</span></div></section>
      <div class="team-dashboard-grid"><section class="team-panel"><div class="team-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> TEAM OVERVIEW</p><h2>Your <span>roster.</span></h2></div><span class="team-member-count">${members.length} MEMBERS</span></div><div class="team-member-list">${memberCards}</div><p class="team-invitation-empty">Captain transfer and self-leave are not supported by the current backend API.</p><button class="team-leave-button" type="button" data-team-action="leave">Leave Team</button></section>
      <section class="team-panel"><div class="team-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> TOURNAMENT HISTORY</p><h2>Recent <span>battles.</span></h2></div></div><div class="team-recent-list">${unavailable}</div><a class="text-link" href="tournaments.html">Explore tournaments <span aria-hidden="true">↗</span></a></section>${invitationMarkup}</div>`;
  }

  async function renderTeamPage() {
    const loading = document.querySelector('#team-loading');
    const empty = document.querySelector('#team-empty');
    const dashboard = document.querySelector('#team-dashboard');
    if (!dashboard || !auth.isLoggedIn()) return;
    loading.hidden = true;
    const requestedId = new URLSearchParams(location.search).get('id');
    let team = null;
    try {
      team = requestedId ? await teams.loadTeam(requestedId) : teams.getUserTeam();
    } catch (error) {
      empty.hidden = false;
      dashboard.hidden = true;
      empty.querySelector('h2').textContent = error.message;
      empty.querySelector('p').textContent = 'Team information could not be loaded from the backend.';
      return;
    }
    if (!team || !team.members.some((member) => member.userId === auth.getCurrentUser().userId)) {
      dashboard.hidden = true;
      empty.hidden = false;
      empty.querySelector('h2').textContent = 'Team is not available';
      empty.querySelector('p').textContent = 'The current backend API cannot list teams for your account. Use an existing team link, or submit a create request; the server will check current membership.';
      renderInvitations();
      return;
    }
    empty.hidden = true;
    dashboard.hidden = false;
    dashboard.innerHTML = renderTeamDashboard(team);
    renderInvitations();
  }

  function renderProfileTeam() {
    const teamField = document.querySelector('[data-profile-field="teamId"]');
    if (!teamField) return;
    const team = teams.getUserTeam();
    const container = teamField.closest('div');
    container.querySelectorAll('.profile-team-extra').forEach((node) => node.remove());
    if (!team) {
      teamField.textContent = 'Team details unavailable';
      const link = document.createElement('a');
      link.className = 'profile-team-link profile-team-extra';
      link.href = 'my-team.html';
      link.textContent = 'Create Team';
      container.append(link);
      return;
    }
    const member = team.members.find((entry) => entry.userId === auth.getCurrentUser()?.userId);
    teamField.textContent = `${team.teamName} [${team.teamTag}]`;
    const logo = document.createElement('span');
    logo.className = 'profile-team-logo profile-team-extra';
    logo.textContent = team.logo || team.teamTag.slice(0, 3);
    const role = document.createElement('span');
    role.className = 'profile-team-role profile-team-extra';
    role.textContent = member?.role || 'MEMBER';
    const link = document.createElement('a');
    link.className = 'profile-team-link profile-team-extra';
    link.href = `team.html?id=${encodeURIComponent(team.teamId)}`;
    link.textContent = 'Open Team';
    container.append(logo, role, link);
  }

  async function showTeamResult(result) {
    if (!result.success) {
      showToast(result.message, true);
      return;
    }
    teamDialog?.close();
    showToast(result.message || 'Team updated.');
    await renderTeamPage();
    renderInvitations();
    renderProfileTeam();
  }

  async function teamAction(action, button) {
    const currentTeam = teams.getUserTeam();
    if (action === 'create') {
      openTeamForm('create');
    } else if (action === 'edit' && currentTeam) {
      openTeamForm('edit', currentTeam);
    } else if (action === 'invite' && currentTeam) {
      document.querySelector('#team-invite-username')?.focus();
    } else if (action === 'accept-invite') {
      await showTeamResult(await teams.acceptTeamInvitation(button.dataset.id));
    } else if (action === 'decline-invite') {
      await showTeamResult(await teams.declineTeamInvitation(button.dataset.id));
    } else if (action === 'remove-member' && currentTeam) {
      const member = currentTeam.members.find((entry) => entry.userId === button.dataset.userId);
      if (!member) return;
      openConfirmation('Remove player?', `Remove ${member.username} from ${currentTeam.teamName}?`, 'Remove member', () => teams.removeTeamMember(currentTeam.teamId, member.userId));
    } else if (action === 'leave' && currentTeam) {
      openConfirmation('Leave this team?', currentTeam.ownerId === auth.getCurrentUser().userId && currentTeam.members.length > 1 ? 'Transfer captain first. You cannot leave while members remain.' : `Leave ${currentTeam.teamName}?`, 'Leave team', () => teams.leaveTeam(currentTeam.teamId));
    }
  }

  function setupTeamForms() {
    document.addEventListener('submit', async (event) => {
      const form = event.target;
      if (form.matches('#team-form')) {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form).entries());
        const message = form.querySelector('[data-team-message]');
        const result = await (form.dataset.mode === 'edit'
          ? teams.updateTeam(teams.getUserTeam()?.teamId, values)
          : teams.createTeam(values));
        if (!result.success) {
          message.textContent = result.message;
          if (result.field) form.elements.namedItem(result.field)?.focus();
          return;
        }
        teamDialog.close();
        showToast(form.dataset.mode === 'edit' ? 'Team details updated.' : `${result.team.teamName} is ready. You are the captain.`);
        await renderTeamPage();
        renderProfileTeam();
      } else if (form.matches('[data-team-invite-form]')) {
        event.preventDefault();
        const result = await teams.sendTeamInvitation(form.dataset.teamInviteForm, new FormData(form).get('username'));
        const feedback = form.querySelector('.team-invite-result');
        feedback.textContent = result.success ? `Invitation sent to ${result.invitation.receiverId}.` : result.message;
        feedback.classList.toggle('is-error', !result.success);
        if (result.success) {
          form.reset();
          renderTeamPage();
        }
      } else if (form.matches('[data-team-transfer-form]')) {
        event.preventDefault();
        const memberId = new FormData(form).get('memberId');
        const team = teams.getUserTeam();
        const member = team?.members.find((entry) => entry.userId === memberId);
        if (!team || !member) return;
        openConfirmation('Transfer captain?', `${member.username} will become captain. You will become a member.`, 'Transfer captain', () => teams.transferCaptain(team.teamId, memberId));
      }
    });
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-team-action]');
    if (button) await teamAction(button.dataset.teamAction, button);
  });
  document.addEventListener('input', (event) => {
    if (!event.target.matches('#team-invite-username')) return;
    const feedback = document.querySelector('.team-invite-result');
    const user = auth.findUserByUsername(event.target.value);
    feedback.textContent = user ? `Player found: ${user.username}` : event.target.value.trim() ? 'No player found yet.' : '';
    feedback.classList.remove('is-error');
  });
  setupTeamForms();

  Promise.all([auth.ready, teams.ready]).then(async () => {
    if (!auth.isLoggedIn()) return;
    if (document.querySelector('#team-dashboard')) await renderTeamPage();
    if (document.querySelector('#team-invitations-list')) renderInvitations();
    if (document.querySelector('#profile-content')) renderProfileTeam();
  });
})();
