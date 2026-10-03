(() => {
  const STORAGE_KEY = 'arenaX_notifications';
  const auth = globalThis.ArenaAuth;
  const apiClient = globalThis.ArenaApi;
  const tournaments = globalThis.ArenaTournaments;
  const teams = globalThis.ArenaTeams;
  const matches = globalThis.ArenaMatches;
  if (!auth) return;
  let backendNotifications = [];
  let backendNotificationError = null;

  function readState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return { items: [], writable: true };
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? { items: parsed, writable: true } : { items: [], writable: false };
    } catch {
      return { items: [], writable: false };
    }
  }

  function saveItems(items) {
    if (!readState().writable) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      return true;
    } catch {
      return false;
    }
  }

  function isValidNotification(notification) {
    return Boolean(notification && typeof notification === 'object' && !Array.isArray(notification)
      && typeof notification.id === 'string' && notification.id.trim()
      && typeof notification.userId === 'string' && notification.userId.trim()
      && typeof notification.type === 'string' && notification.type.trim()
      && typeof notification.title === 'string'
      && typeof notification.message === 'string'
      && typeof notification.createdAt === 'string' && Number.isFinite(Date.parse(notification.createdAt)));
  }

  function canAccess(userId) {
    return Boolean(userId && auth.getCurrentUser()?.userId === userId);
  }

  function getNotifications(userId = auth.getCurrentUser()?.userId) {
    if (!canAccess(userId)) return [];
    return [...readState().items.filter((item) => isValidNotification(item) && item.userId === userId), ...backendNotifications.filter((item) => item.userId === userId)]
      .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
  }

  async function loadBackendNotifications(userId = auth.getCurrentUser()?.userId) {
    if (!apiClient || !canAccess(userId)) return [];
    try {
      const response = await apiClient.request('/api/notifications');
      if (!Array.isArray(response.notifications)) throw new Error('The backend returned an invalid notification list.');
      backendNotifications = response.notifications.map((item) => {
        if (!item || typeof item.id !== 'string' || typeof item.type !== 'string'
          || typeof item.title !== 'string' || typeof item.message !== 'string'
          || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) {
          throw new Error('The backend returned an invalid notification record.');
        }
        return { ...item, userId, source: 'backend' };
      });
      backendNotificationError = null;
      return backendNotifications;
    } catch (error) {
      backendNotifications = [];
      backendNotificationError = error;
      return [];
    }
  }

  function getUnreadCount(userId = auth.getCurrentUser()?.userId) {
    return getNotifications(userId).filter((item) => !item.read).length;
  }

  function refreshNavigationCount() {
    const badge = document.querySelector('.account-notification-count');
    if (!badge) return;
    const count = getUnreadCount();
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  function startTimestamp(tournament) {
    const time = /^(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*IST)?$/i.exec(String(tournament.startTime || '').trim());
    if (!time || !/^\d{4}-\d{2}-\d{2}$/.test(tournament.startDate || '')) return NaN;
    let hour = Number(time[1]) % 12;
    if (time[3].toUpperCase() === 'PM') hour += 12;
    return new Date(`${tournament.startDate}T${String(hour).padStart(2, '0')}:${time[2]}:00+05:30`).getTime();
  }

  function syncFromData(userId = auth.getCurrentUser()?.userId) {
    if (!canAccess(userId) || !tournaments || !teams || !matches) return getNotifications(userId);
    const state = readState();
    if (!state.writable) return state.items.filter((item) => item && item.userId === userId);
    const items = [...state.items];
    const ids = new Set(items.map((item) => item?.id));
    const add = (sourceKey, type, title, message, relatedId, createdAt) => {
      const id = `notification:${sourceKey}`;
      if (ids.has(id) || !createdAt || Number.isNaN(new Date(createdAt).getTime())) return;
      ids.add(id);
      items.push({ id, userId, type, title, message, relatedId: relatedId || null, createdAt, read: false });
    };

    const registrations = tournaments.getUserTournamentRegistrations(userId);
    registrations.forEach((registration) => {
      const tournament = tournaments.getTournamentById(registration.tournamentId);
      if (!tournament) return;
      if (registration.registeredAt) {
        add(`tournament-joined:${registration.registrationId}`, 'tournament_joined', 'Tournament joined', `Your entry for ${tournament.name} is confirmed.`, tournament.id, registration.registeredAt);
      }
      if (tournament.status === 'Completed') {
        add(`tournament-completed:${tournament.id}`, 'tournament_completed', 'Tournament completed', `${tournament.name} has finished.`, tournament.id, registration.registeredAt || tournament.createdAt);
      }
      const start = startTimestamp(tournament);
      const remaining = start - Date.now();
      if (remaining > 0 && remaining <= 24 * 60 * 60 * 1000) {
        add(`tournament-starting:${tournament.id}`, 'tournament_starting', 'Tournament starting soon', `${tournament.name} is scheduled within the next 24 hours.`, tournament.id, new Date().toISOString());
      }
    });

    const userTeams = teams.getTeams().filter((team) => team.status === 'active' && team.members?.some((member) => member.userId === userId));
    userTeams.forEach((team) => {
      if (team.ownerId === userId) {
        add(`team-created:${team.teamId}`, 'team_created', 'Team created', `${team.teamName} [${team.teamTag}] is ready.`, team.teamId, team.createdAt);
        team.members.filter((member) => member.userId !== userId).forEach((member) => {
          add(`team-member-joined:${team.teamId}:${member.userId}`, 'team_member_joined', 'Player joined your team', `${member.username} joined ${team.teamName}.`, team.teamId, member.joinedAt);
        });
      } else {
        const ownMembership = team.members.find((member) => member.userId === userId);
        add(`team-joined:${team.teamId}:${userId}`, 'team_member_joined', 'Team joined', `You joined ${team.teamName} [${team.teamTag}].`, team.teamId, ownMembership?.joinedAt);
      }
    });

    teams.getUserInvitations(userId).forEach((invitation) => {
      add(`team-invitation:${invitation.invitationId}`, 'team_invitation', 'Team invitation', `You have been invited to ${invitation.teamName}.`, invitation.teamId, invitation.createdAt);
    });

    const teamIds = new Set(userTeams.map((team) => team.teamId));
    matches.getMyMatches(userId).forEach((match) => {
      const tournament = tournaments.getTournamentById(match.tournamentId);
      const matchLabel = `Match ${match.matchNumber}: ${match.title}`;
      const createdAt = match.updatedAt || match.createdAt;
      if (match.status === 'upcoming' || match.status === 'live') {
        add(`match-state:${match.matchId}:${match.status}`, match.status === 'live' ? 'match_live' : 'match_upcoming', match.status === 'live' ? 'Match is live' : 'Upcoming match', `${matchLabel}${tournament ? ` · ${tournament.name}` : ''}`, match.matchId, createdAt);
      }
      if (match.status !== 'completed') return;
      add(`match-completed:${match.matchId}`, 'match_completed', 'Match completed', `${matchLabel}${tournament ? ` · ${tournament.name}` : ''} is complete.`, match.matchId, createdAt);
      if (match.resultStatus !== 'published') return;
      const hasUserResult = (match.results || []).some((result) => result.playerId === userId || (result.teamId && teamIds.has(result.teamId)));
      if (!hasUserResult) return;
      add(`result-published:${match.matchId}:${userId}`, 'result_published', 'Match result published', `The result for ${matchLabel} is available.`, match.matchId, createdAt);
      add(`leaderboard-updated:${match.matchId}:${userId}`, 'leaderboard_updated', 'Leaderboard updated', `Standings changed after ${matchLabel}.`, null, createdAt);
    });

    if (items.length !== state.items.length && saveItems(items)) return getNotifications(userId);
    return getNotifications(userId);
  }

  function markRead(notificationId, userId = auth.getCurrentUser()?.userId) {
    if (!canAccess(userId)) return false;
    if (backendNotifications.some((item) => item.id === notificationId && item.userId === userId)) return false;
    const state = readState();
    if (!state.writable) return false;
    let changed = false;
    const items = state.items.map((item) => {
      if (!item || item.id !== notificationId || item.userId !== userId || item.read) return item;
      changed = true;
      return { ...item, read: true };
    });
    return changed && saveItems(items);
  }

  function markAllRead(userId = auth.getCurrentUser()?.userId) {
    if (!canAccess(userId)) return false;
    const state = readState();
    if (!state.writable) return false;
    let changed = false;
    const items = state.items.map((item) => {
      if (!item || item.userId !== userId || item.read) return item;
      changed = true;
      return { ...item, read: true };
    });
    return changed ? saveItems(items) : true;
  }

  async function markBackendRead(notificationId, userId = auth.getCurrentUser()?.userId) {
    if (!canAccess(userId) || !apiClient) return false;
    const notification = backendNotifications.find((item) => item.id === notificationId && item.userId === userId);
    if (!notification || notification.read) return false;
    try {
      await apiClient.request(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'PATCH', body: {} });
      backendNotifications = backendNotifications.map((item) => item.id === notificationId ? { ...item, read: true } : item);
      return true;
    } catch (error) {
      backendNotificationError = error;
      return false;
    }
  }

  async function markAllBackendRead(userId = auth.getCurrentUser()?.userId) {
    if (!canAccess(userId)) return false;
    const pending = backendNotifications.filter((item) => item.userId === userId && !item.read);
    const results = await Promise.all(pending.map((item) => markBackendRead(item.id, userId)));
    return results.every(Boolean);
  }

  function deleteNotification(notificationId, userId = auth.getCurrentUser()?.userId) {
    if (!canAccess(userId)) return false;
    const state = readState();
    if (!state.writable) return false;
    const items = state.items.filter((item) => !item || item.id !== notificationId || item.userId !== userId);
    return items.length !== state.items.length && saveItems(items);
  }

  const api = Object.freeze({ getNotifications, getUnreadCount, syncFromData, loadBackendNotifications, markRead, markBackendRead, markAllRead, markAllBackendRead, deleteNotification });
  globalThis.ArenaNotifications = api;

  let currentUser = auth.getCurrentUser();

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const dateLabel = (value) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

  function notificationHref(notification) {
    if (notification.type.startsWith('tournament_')) return `tournament.html?id=${encodeURIComponent(notification.relatedId || '')}`;
    if (notification.type === 'team_invitation') return 'my-team.html';
    if (notification.type === 'team_created' || notification.type === 'team_member_joined') {
      const ownTeam = teams?.getUserTeam(currentUser.userId);
      return ownTeam?.teamId === notification.relatedId ? `team.html?id=${encodeURIComponent(notification.relatedId)}` : 'my-team.html';
    }
    if (notification.type.startsWith('match_') || notification.type === 'result_published') return `match.html?id=${encodeURIComponent(notification.relatedId || '')}`;
    if (notification.type === 'leaderboard_updated') return 'leaderboard.html';
    return 'profile.html';
  }

  function notificationMarkup(notification) {
    const href = notificationHref(notification);
    return `<article class="notification-item ${notification.read ? 'is-read' : 'is-unread'}" data-notification-id="${escapeHtml(notification.id)}"><div class="notification-item-main"><span class="notification-type">${escapeHtml(notification.type.replaceAll('_', ' ').toUpperCase())}</span><h2>${escapeHtml(notification.title)}</h2><p>${escapeHtml(notification.message)}</p><time datetime="${escapeHtml(notification.createdAt)}">${escapeHtml(dateLabel(notification.createdAt))}</time></div><div class="notification-item-actions"><a class="button button-card" href="${href}">Open <span aria-hidden="true">↗</span></a>${notification.read ? '<span class="notification-read-label">READ</span>' : '<button class="button button-outline" type="button" data-notification-read>Mark read</button>'}${notification.source === 'backend' ? '' : '<button class="notification-delete" type="button" aria-label="Delete notification" data-notification-delete>×</button>'}</div></article>`;
  }

  function renderNotifications(container, items, emptyText) {
    const empty = container.parentElement.querySelector('[data-notifications-empty]');
    container.innerHTML = items.map(notificationMarkup).join('');
    if (empty) empty.hidden = items.length !== 0;
    if (empty && items.length === 0) empty.querySelector('p').textContent = emptyText;
  }

  function renderPage() {
    const list = document.querySelector('#notifications-list');
    if (!list) return;
    const notifications = getNotifications(currentUser.userId);
    const filter = document.querySelector('[data-notification-filter].is-active')?.dataset.notificationFilter || 'all';
    const visible = filter === 'unread' ? notifications.filter((item) => !item.read) : notifications;
    renderNotifications(list, visible, filter === 'unread' ? 'No unread notifications.' : 'No notifications.');
    const errorTarget = document.querySelector('#notifications-error');
    if (errorTarget) {
      errorTarget.hidden = !backendNotificationError;
      errorTarget.textContent = backendNotificationError ? 'Some server notifications could not be loaded. Refresh when the service is available.' : '';
    }
    document.querySelector('#notifications-count').textContent = `${notifications.length} TOTAL`;
    document.querySelector('#notifications-mark-all').disabled = notifications.every((item) => item.read);
    refreshNavigationCount();
  }

  document.addEventListener('click', (event) => {
    if (!currentUser) return;
    const filter = event.target.closest('[data-notification-filter]');
    if (filter) {
      document.querySelectorAll('[data-notification-filter]').forEach((button) => {
        const selected = button === filter;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      renderPage();
    }
    const item = event.target.closest('[data-notification-id]');
    if (item && event.target.closest('[data-notification-read]')) {
      const notificationId = item.dataset.notificationId;
      if (backendNotifications.some((notification) => notification.id === notificationId)) {
        markBackendRead(notificationId, currentUser.userId).then((success) => {
          if (!success) backendNotificationError = new Error('The notification could not be marked read.');
          renderPage();
        });
      } else {
        markRead(notificationId, currentUser.userId);
      }
      renderPage();
    }
    if (item && event.target.closest('[data-notification-delete]')) {
      deleteNotification(item.dataset.notificationId, currentUser.userId);
      renderPage();
    }
    if (event.target.closest('#notifications-mark-all')) {
      markAllRead(currentUser.userId);
      markAllBackendRead(currentUser.userId).then((success) => {
        if (!success) backendNotificationError = new Error('Some server notifications could not be marked read.');
        renderPage();
      });
      renderPage();
    }
  });

  async function initializeUserNotifications() {
    await Promise.all([matches?.ready, tournaments?.ready, teams?.ready]);
    currentUser = auth.getCurrentUser();
    if (!currentUser) return;
    await loadBackendNotifications(currentUser.userId);
    if (document.querySelector('#profile-content') || document.body.dataset.page === 'notifications') syncFromData(currentUser.userId);
    refreshNavigationCount();
    const profilePreview = document.querySelector('#profile-notifications-preview');
    if (profilePreview) {
      const unread = getNotifications(currentUser.userId).filter((item) => !item.read).slice(0, 3);
      renderNotifications(profilePreview, unread, 'No notifications.');
    }
    renderPage();
  }

  auth.ready.then(initializeUserNotifications);
})();
