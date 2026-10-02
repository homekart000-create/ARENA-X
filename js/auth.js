(() => {
  const USERS_KEY = 'arena-x-users-v1';
  const SESSION_KEY = 'arena-x-session-v1';
  const NOTICE_KEY = 'arena-x-notice-v1';
  const RETURN_KEY = 'arena-x-return-v1';
  const PENDING_TOURNAMENT_KEY = 'arenaX_pendingTournament';
  const NOTIFICATIONS_KEY = 'arenaX_notifications';
  const apiReady = globalThis.ArenaApi ? Promise.resolve(globalThis.ArenaApi) : new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = new URL('js/api.js', document.baseURI).href;
    script.onload = () => resolve(globalThis.ArenaApi || null);
    script.onerror = () => resolve(null);
    document.head.append(script);
  });
  const backendApi = Object.freeze({
    request: async (...args) => {
      const client = await apiReady;
      if (!client) {
        const error = new Error('Authentication service is unavailable. Please try again later.');
        error.code = 'BACKEND_UNAVAILABLE';
        throw error;
      }
      return client.request(...args);
    }
  });
  let backendUser = null;
  let sessionError = null;
  let sessionChecked = false;

  function isUserRecord(user) {
    return Boolean(user && typeof user === 'object' && !Array.isArray(user)
      && typeof user.userId === 'string' && user.userId.trim()
      && typeof user.username === 'string' && user.username.trim());
  }

  function removeLegacyCredentials() {
    try {
      const raw = localStorage.getItem(USERS_KEY);
      if (raw !== null) {
        const users = JSON.parse(raw);
        if (Array.isArray(users)) {
          const cleaned = users.map((user) => {
            if (!user || typeof user !== 'object' || Array.isArray(user)) return user;
            const {
              password, passwordHash, password_hash, sessionToken, sessionTokenHash, accessToken, refreshToken,
              authToken, token, session_token, session_token_hash, access_token, refresh_token, auth_token,
              token_hash, walletBalance, ...safeUser
            } = user;
            return safeUser;
          });
          localStorage.setItem(USERS_KEY, JSON.stringify(cleaned));
        }
      }
      localStorage.removeItem(SESSION_KEY);
    } catch {
      try { localStorage.removeItem(SESSION_KEY); } catch { /* Storage may be unavailable. */ }
    }
  }

  function readUsersState() {
    try {
      const raw = localStorage.getItem(USERS_KEY);
      if (raw === null) return { users: [], valid: true };
      const users = JSON.parse(raw);
      if (!Array.isArray(users)) return { users: [], valid: false };
      return { users: users.filter(isUserRecord), valid: users.every(isUserRecord) };
    } catch {
      return { users: [], valid: false };
    }
  }

  function readUsers() {
    return readUsersState().users;
  }

  function findStoredUserById(userId) {
    return readUsers().find((user) => user.userId === userId) || null;
  }

  function sanitizeUser(user, includePrivateProfile = false) {
    if (!user) return null;
    const safeUser = {
      userId: user.userId,
      fullName: user.fullName,
      username: user.username,
      avatar: user.avatar,
      createdAt: user.createdAt,
      joinedTournaments: Array.isArray(user.joinedTournaments) ? [...user.joinedTournaments] : [],
      teamId: typeof user.teamId === 'string' ? user.teamId : null,
      wins: user.wins ?? 0,
      matches: user.matches ?? 0,
      kills: user.kills ?? 0,
      points: user.points ?? 0
    };
    if (includePrivateProfile) {
      safeUser.email = user.email;
      safeUser.phone = user.phone;
      safeUser.dateOfBirth = user.dateOfBirth;
    }
    return safeUser;
  }

  function getUserById(userId) {
    return sanitizeUser(findStoredUserById(userId));
  }

  function getUsers() {
    if (!isAdmin()) return [];
    return readUsers().map((user) => ({
      userId: user.userId,
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      avatar: user.avatar,
      createdAt: user.createdAt
    }));
  }

  function findUserByUsername(username) {
    const normalized = String(username || '').trim().toLowerCase();
    if (!normalized) return null;
    return sanitizeUser(readUsers().find((user) => user.username?.toLowerCase() === normalized) || null);
  }

  function writeUsers(users) {
    if (!readUsersState().valid) return false;
    try {
      localStorage.setItem(USERS_KEY, JSON.stringify(users));
      return true;
    } catch {
      return false;
    }
  }

  function getCurrentUserRecord() {
    if (!backendUser) return null;
    const cached = findStoredUserById(backendUser.userId) || {};
    return {
      userId: backendUser.userId,
      fullName: backendUser.fullName,
      username: backendUser.username,
      email: backendUser.email,
      avatar: backendUser.avatar,
      createdAt: backendUser.createdAt,
      joinedTournaments: Array.isArray(cached.joinedTournaments) ? cached.joinedTournaments : [],
      teamId: typeof cached.teamId === 'string' ? cached.teamId : null,
      wins: cached.wins ?? 0,
      matches: cached.matches ?? 0,
      kills: cached.kills ?? 0,
      points: cached.points ?? 0
    };
  }

  function getCurrentUser() {
    return sanitizeUser(getCurrentUserRecord(), true);
  }

  function isLoggedIn() {
    return backendUser !== null && backendUser.status === 'active';
  }

  function cacheBackendUser(user) {
    if (!user || typeof user.userId !== 'string' || !user.userId.trim()
      || typeof user.username !== 'string' || !user.username.trim()
      || !['user', 'admin'].includes(user.role) || user.status !== 'active') return false;
    backendUser = {
      userId: user.userId,
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      avatar: user.avatar ?? null,
      createdAt: user.createdAt,
      role: user.role,
      status: user.status
    };
    const users = readUsers();
    const index = users.findIndex((entry) => entry.userId === backendUser.userId);
    const cached = index >= 0 ? users[index] : {
      userId: backendUser.userId,
      joinedTournaments: [],
      teamId: null,
      wins: 0,
      matches: 0,
      kills: 0,
      points: 0
    };
    const safeProfile = { ...cached, ...backendUser };
    delete safeProfile.password;
    delete safeProfile.passwordHash;
    delete safeProfile.role;
    delete safeProfile.status;
    delete safeProfile.isDemo;
    delete safeProfile.walletBalance;
    if (index >= 0) users[index] = safeProfile;
    else users.push(safeProfile);
    writeUsers(users);
    return true;
  }

  async function checkSession() {
    try {
      const response = await backendApi.request('/api/auth/me');
      if (!cacheBackendUser(response.user)) throw new Error('Invalid authentication response.');
      sessionError = null;
    } catch (error) {
      backendUser = null;
      sessionError = error;
    }
    sessionChecked = true;
    return backendUser;
  }

  function authFailure(error) {
    const messages = {
      UNAUTHORIZED: 'Email/username or password was not recognized. Check your details or account status.',
      CONFLICT: 'An account with those details already exists.',
      BAD_REQUEST: 'Check the details and try again.',
      VALIDATION: 'Check the details and try again.',
      FORBIDDEN: 'This action is not allowed from this website.',
      RATE_LIMITED: 'Too many attempts. Please wait and try again.',
      NETWORK: 'Could not reach the authentication service. Check your connection or backend configuration.',
      BACKEND_UNAVAILABLE: 'Authentication service is unavailable. Please try again later.',
      CONFIGURATION: 'The backend API URL is not configured correctly. Check the frontend API configuration.',
      NOT_FOUND: 'The authentication service endpoint is unavailable. Check the backend URL.',
      REQUEST_FAILED: 'The authentication request could not be completed. Please try again.'
    };
    return messages[error?.code] || 'Authentication service is unavailable. Please try again later.';
  }

  async function loginUser(identifier, password) {
    try {
      if (!sessionChecked) await ready;
      await backendApi.request('/api/auth/login', { method: 'POST', body: { identifier, password } });
      await checkSession();
      if (!backendUser) return { success: false, message: 'Login could not be verified. Please try again.' };
      return { success: true, user: getCurrentUser() };
    } catch (error) {
      return { success: false, message: authFailure(error) };
    }
  }

  async function registerUser(profile) {
    try {
      if (!sessionChecked) await ready;
      await backendApi.request('/api/auth/register', {
        method: 'POST',
        body: {
          fullName: profile.fullName,
          username: profile.username,
          email: profile.email,
          password: profile.password,
          phone: profile.phone,
          dateOfBirth: profile.dateOfBirth
        }
      });
      await checkSession();
      if (!backendUser) return { success: false, message: 'Your account was created, but login could not be verified. Please log in.' };
      return { success: true, user: getCurrentUser() };
    } catch (error) {
      return { success: false, message: authFailure(error) };
    }
  }

  function canUpdateTeamMembership(actor, userId, teamId) {
    const target = findStoredUserById(userId);
    const teamStore = globalThis.ArenaTeams;
    if (!actor || !target || !teamStore) return false;
    if (teamId === null) {
      const currentTeam = typeof target.teamId === 'string' ? teamStore.getTeamById(target.teamId) : null;
      const targetRemainsMember = Boolean(currentTeam?.members?.some((member) => member.userId === userId));
      if (userId === actor.userId) return !targetRemainsMember;
      return currentTeam?.ownerId === actor.userId && !targetRemainsMember;
    }
    if (typeof teamId !== 'string') return false;
    const nextTeam = teamStore.getTeamById(teamId);
    const isMember = nextTeam?.members?.some((member) => member.userId === userId);
    return Boolean(isMember && (userId === actor.userId || nextTeam.ownerId === actor.userId));
  }

  function canUpdateTournamentHistory(actor, userId, tournamentIds, previousIds) {
    if (!actor || !Array.isArray(tournamentIds) || !tournamentIds.every((id) => typeof id === 'string')) return false;
    if (!findStoredUserById(userId)) return false;
    const previous = new Set(Array.isArray(previousIds) ? previousIds : []);
    const next = new Set(tournamentIds);
    const changed = [...new Set([...previous, ...next])].filter((id) => previous.has(id) !== next.has(id));
    if (changed.length === 0) return userId === actor.userId;
    const participants = globalThis.ArenaTournaments?.getParticipants?.() || [];
    return changed.every((tournamentId) => participants.some((registration) => {
      if (registration.tournamentId !== tournamentId || String(registration.status || 'registered').toLowerCase() === 'cancelled') return false;
      const members = [registration.userId, ...(Array.isArray(registration.memberIds) ? registration.memberIds : [])];
      return members.includes(userId) && members.includes(actor.userId);
    }));
  }

  function updateUser(userId, updates) {
    const actor = getCurrentUserRecord();
    const users = readUsers();
    const index = users.findIndex((user) => user.userId === userId);
    if (index < 0) return { success: false, message: 'User not found.' };
    if (!actor || !updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return { success: false, message: 'Account update is not authorized.' };
    }
    const keys = Object.keys(updates);
    if (keys.length === 1 && keys[0] === 'teamId'
      && (updates.teamId === null || (typeof updates.teamId === 'string' && /^[a-z0-9_-]+$/i.test(updates.teamId)))
      && canUpdateTeamMembership(actor, userId, updates.teamId)) {
      users[index] = { ...users[index], teamId: updates.teamId };
      if (!writeUsers(users)) return { success: false, message: 'Your browser could not save this update.' };
      return { success: true, user: sanitizeUser(users[index], userId === actor.userId) };
    }
    if (keys.length === 1 && keys[0] === 'joinedTournaments'
      && canUpdateTournamentHistory(actor, userId, updates.joinedTournaments, users[index].joinedTournaments)) {
      users[index] = { ...users[index], joinedTournaments: [...new Set(updates.joinedTournaments)] };
      if (!writeUsers(users)) return { success: false, message: 'Your browser could not save this update.' };
      return { success: true, user: sanitizeUser(users[index], userId === actor.userId) };
    }

    const profileFields = new Set(['fullName', 'username', 'email', 'phone', 'dateOfBirth', 'avatar']);
    if (userId !== actor.userId || keys.length === 0 || !keys.every((key) => profileFields.has(key))) {
      return { success: false, message: 'Account update is not authorized.' };
    }
    const cleanUpdates = {};
    for (const key of keys) {
      if (typeof updates[key] !== 'string') return { success: false, message: 'Enter valid account details.' };
      cleanUpdates[key] = updates[key].trim();
    }
    if (cleanUpdates.fullName !== undefined && cleanUpdates.fullName.length < 2) return { success: false, field: 'fullName', message: 'Enter your full name.' };
    if (cleanUpdates.username !== undefined && !/^[a-zA-Z0-9_]{3,20}$/.test(cleanUpdates.username)) return { success: false, field: 'username', message: 'Use 3-20 letters, numbers, or underscores.' };
    if (cleanUpdates.email !== undefined) {
      cleanUpdates.email = cleanUpdates.email.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanUpdates.email)) return { success: false, field: 'email', message: 'Enter a valid email address.' };
    }
    if (cleanUpdates.dateOfBirth !== undefined && (!cleanUpdates.dateOfBirth || Number.isNaN(Date.parse(cleanUpdates.dateOfBirth)) || new Date(cleanUpdates.dateOfBirth) > new Date())) {
      return { success: false, field: 'dateOfBirth', message: 'Enter a valid date in the past.' };
    }
    if (cleanUpdates.username && users.some((user, userIndex) => userIndex !== index && user.username?.toLowerCase() === cleanUpdates.username.toLowerCase())) {
      return { success: false, field: 'username', message: 'That username is already in use.' };
    }
    if (cleanUpdates.email && users.some((user, userIndex) => userIndex !== index && user.email?.toLowerCase() === cleanUpdates.email)) {
      return { success: false, field: 'email', message: 'That email address is already registered.' };
    }
    users[index] = { ...users[index], ...cleanUpdates };
    if (!writeUsers(users)) return { success: false, message: 'Your browser could not save this update.' };
    return { success: true, user: sanitizeUser(users[index]) };
  }

  async function logoutUser() {
    try {
      await backendApi.request('/api/auth/logout', { method: 'POST' });
      backendUser = null;
      sessionError = null;
      return { success: true };
    } catch {
      backendUser = null;
      sessionError = { code: 'BACKEND_UNAVAILABLE' };
      return { success: false };
    }
  }

  function saveNotice(message, type = 'success') {
    try {
      localStorage.setItem(NOTICE_KEY, JSON.stringify({ message, type }));
    } catch {
      return false;
    }
    return true;
  }

  function consumeNotice() {
    try {
      const notice = JSON.parse(localStorage.getItem(NOTICE_KEY) || 'null');
      localStorage.removeItem(NOTICE_KEY);
      return notice && typeof notice.message === 'string' ? notice : null;
    } catch {
      localStorage.removeItem(NOTICE_KEY);
      return null;
    }
  }

  function getUnreadNotificationCount(userId) {
    try {
      const notifications = JSON.parse(localStorage.getItem(NOTIFICATIONS_KEY) || '[]');
      return Array.isArray(notifications)
        ? notifications.filter((notification) => notification && notification.userId === userId && !notification.read).length
        : 0;
    } catch {
      return 0;
    }
  }

  async function requireLogin() {
    if (!sessionChecked) await ready;
    if (isLoggedIn()) return true;
    const page = location.pathname.split('/').pop();
    const teamId = page === 'team.html' ? new URLSearchParams(location.search).get('id') : null;
    const target = page === 'team.html'
      ? (teamId && /^[a-z0-9_-]+$/i.test(teamId) ? `team.html?id=${teamId}` : 'my-team.html')
      : ['profile.html', 'my-tournaments.html', 'my-team.html', 'notifications.html', 'wallet.html', 'admin.html'].includes(page) ? page : 'index.html';
    saveReturnTarget(target);
    const message = sessionError?.code === 'UNAUTHORIZED' ? 'You need an active session. Log in to continue.'
      : sessionError ? 'Authentication service is unavailable. Please try again when the backend is reachable.'
        : page === 'profile.html' ? 'Log in is required to view your profile.'
        : page === 'notifications.html' ? 'Log in is required to view your notifications.'
          : page === 'wallet.html' ? 'Log in is required to view your wallet.'
        : page === 'admin.html' ? 'Log in to continue to Admin.'
        : 'Log in is required to view your team.';
    saveNotice(message, sessionError && sessionError.code !== 'UNAUTHORIZED' ? 'error' : 'info');
    location.replace('login.html');
    return false;
  }

  function getCurrentUserRole() {
    return backendUser?.status === 'active' ? backendUser.role : 'user';
  }

  function isAdmin() {
    return getCurrentUserRole() === 'admin';
  }

  async function requireAdmin() {
    if (!sessionChecked) await ready;
    if (isAdmin()) return true;
    if (!isLoggedIn()) {
      saveReturnTarget('admin.html');
      const unavailable = sessionError && sessionError.code !== 'UNAUTHORIZED';
      saveNotice(unavailable ? 'Authentication service is unavailable. Please try again later.' : 'Log in to continue to Admin.', unavailable ? 'error' : 'info');
      location.replace('login.html');
      return false;
    }
    saveNotice('Admin access cannot be confirmed by the current authentication API.', 'info');
    location.replace('index.html');
    return false;
  }

  function saveReturnTarget(target) {
    const value = typeof target === 'string' ? target : '';
    const tournamentMatch = /^tournament\.html\?id=([a-z0-9_-]+)$/i.exec(value);
    const teamMatch = /^team\.html\?id=([a-z0-9_-]+)$/i.exec(value);
    const safeTarget = value === 'profile.html' || value === 'my-tournaments.html' || value === 'my-team.html' || value === 'notifications.html' || value === 'wallet.html' || value === 'admin.html' || value === 'team.html'
      ? value
      : tournamentMatch ? `tournament.html?id=${encodeURIComponent(tournamentMatch[1])}`
        : teamMatch ? `team.html?id=${encodeURIComponent(teamMatch[1])}` : 'index.html';
    try {
      localStorage.setItem(RETURN_KEY, safeTarget);
      return true;
    } catch {
      return false;
    }
  }

  function takeReturnTarget() {
    let target = 'index.html';
    try {
      const saved = localStorage.getItem(RETURN_KEY);
      const tournamentMatch = /^tournament\.html\?id=([a-z0-9_-]+)$/i.exec(saved || '');
      const teamMatch = /^team\.html\?id=([a-z0-9_-]+)$/i.exec(saved || '');
      if (['profile.html', 'my-tournaments.html', 'my-team.html', 'notifications.html', 'wallet.html', 'admin.html', 'team.html'].includes(saved)) target = saved;
      else if (tournamentMatch) target = `tournament.html?id=${encodeURIComponent(tournamentMatch[1])}`;
      else if (teamMatch) target = `team.html?id=${encodeURIComponent(teamMatch[1])}`;
      if (target === 'index.html') {
        const pendingId = localStorage.getItem(PENDING_TOURNAMENT_KEY);
        if (pendingId && /^[a-z0-9_-]+$/i.test(pendingId)) target = `tournament.html?id=${encodeURIComponent(pendingId)}`;
      }
      localStorage.removeItem(RETURN_KEY);
    } catch {
      return target;
    }
    return target;
  }

  function showMessage(element, message, type = 'error') {
    if (!element) return;
    element.textContent = message;
    element.className = `auth-message is-visible is-${type}`;
    element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  }

  function renderHeaderAccount() {
    const slot = document.querySelector('#header-auth');
    if (!slot) return;
    const user = getCurrentUser();
    slot.replaceChildren();
    if (!user) {
      const login = document.createElement('a');
      login.className = 'button button-outline header-login';
      login.href = 'login.html';
      login.textContent = 'Log in';
      const signup = document.createElement('a');
      signup.className = 'header-signup';
      signup.href = 'signup.html';
      signup.textContent = 'Create account';
      slot.append(login, signup);
      return;
    }

    const details = document.createElement('details');
    details.className = 'header-account';
    const summary = document.createElement('summary');
    const avatar = document.createElement('span');
    avatar.className = 'account-avatar';
    avatar.textContent = user.avatar || 'AX';
    const username = document.createElement('span');
    username.className = 'account-username';
    username.textContent = user.username;
    const caret = document.createElement('span');
    caret.className = 'account-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '⌄';
    summary.append(avatar, username, caret);

    const menu = document.createElement('div');
    menu.className = 'account-dropdown';
    const notifications = document.createElement('a');
    notifications.className = 'account-notification-link';
    notifications.href = 'notifications.html';
    const notificationLabel = document.createElement('span');
    notificationLabel.textContent = 'Notifications';
    const notificationCount = document.createElement('span');
    notificationCount.className = 'account-notification-count';
    const unreadCount = getUnreadNotificationCount(user.userId);
    notificationCount.textContent = String(unreadCount);
    notificationCount.hidden = unreadCount === 0;
    notifications.append(notificationLabel, notificationCount);
    const wallet = document.createElement('a');
    wallet.href = 'wallet.html';
    wallet.textContent = 'Wallet';
    const adminLink = isAdmin() ? document.createElement('a') : null;
    if (adminLink) {
      adminLink.href = 'admin.html';
      adminLink.textContent = 'Admin panel';
    }
    const profile = document.createElement('a');
    profile.href = 'profile.html';
    profile.textContent = 'My profile';
    const myTournaments = document.createElement('a');
    myTournaments.href = 'my-tournaments.html';
    myTournaments.textContent = 'My tournaments';
    const myTeam = document.createElement('a');
    myTeam.href = 'my-team.html';
    myTeam.textContent = 'My team';
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.dataset.authAction = 'logout';
    logout.textContent = 'Log out';
    menu.append(notifications, wallet);
    if (adminLink) menu.append(adminLink);
    menu.append(profile, myTournaments, myTeam, logout);
    details.append(summary, menu);
    slot.append(details);
  }

  function ensureTournamentNavigation() {
    document.querySelectorAll('.primary-nav').forEach((nav) => {
      let myTournaments = nav.querySelector('a[href="my-tournaments.html"]');
      if (!myTournaments) {
        myTournaments = document.createElement('a');
        myTournaments.className = 'nav-link';
        myTournaments.href = 'my-tournaments.html';
        myTournaments.textContent = 'My Tournaments';
        const tournamentsLink = nav.querySelector('a[href="tournaments.html"]');
        if (tournamentsLink) tournamentsLink.after(myTournaments);
        else nav.append(myTournaments);
      }
      if (!nav.querySelector('a[href="my-team.html"]')) {
        const myTeam = document.createElement('a');
        myTeam.className = 'nav-link';
        myTeam.href = 'my-team.html';
        myTeam.textContent = 'My Team';
        myTournaments.after(myTeam);
      }
      if (!nav.querySelector('a[href="wallet.html"]')) {
        const wallet = document.createElement('a');
        wallet.className = 'nav-link';
        wallet.href = 'wallet.html';
        wallet.textContent = 'Wallet';
        nav.querySelector('a[href="my-team.html"]').after(wallet);
      }
      let adminLink = nav.querySelector('a[href="admin.html"]');
      if (isAdmin() && !adminLink) {
        adminLink = document.createElement('a');
        adminLink.className = 'nav-link';
        adminLink.href = 'admin.html';
        adminLink.textContent = 'Admin';
        nav.querySelector('a[href="wallet.html"]').after(adminLink);
      } else if (!isAdmin()) {
        adminLink?.remove();
      }
      const currentPage = location.pathname.split('/').pop();
      if (currentPage === 'my-tournaments.html') myTournaments.classList.add('is-current');
      if (currentPage === 'my-team.html' || currentPage === 'team.html') nav.querySelector('a[href="my-team.html"]').classList.add('is-current');
      if (currentPage === 'wallet.html') nav.querySelector('a[href="wallet.html"]').classList.add('is-current');
      if (currentPage === 'admin.html') nav.querySelector('a[href="admin.html"]')?.classList.add('is-current');
    });
  }

  function showToast(message, type = 'success') {
    let region = document.querySelector('.toast-region');
    if (!region) {
      region = document.createElement('div');
      region.className = 'toast-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.append(region);
    }
    const toast = document.createElement('div');
    toast.className = `toast${type === 'error' ? ' is-error' : ''}`;
    toast.textContent = message;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  function renderProfile() {
    const user = getCurrentUser();
    const content = document.querySelector('#profile-content');
    if (!user || !content) return;
    content.hidden = false;
    document.querySelectorAll('[data-profile-field]').forEach((element) => {
      const field = element.dataset.profileField;
      const value = field === 'createdAt' ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(user.createdAt)) : user[field];
      element.textContent = value || 'Not provided';
    });
    document.querySelectorAll('[data-profile-stat]').forEach((element) => {
      element.textContent = String(user[element.dataset.profileStat] ?? 0);
    });
    const avatar = document.querySelector('[data-profile-avatar]');
    if (avatar) avatar.textContent = user.avatar || 'AX';
  }

  function attachPasswordToggles() {
    document.querySelectorAll('[data-password-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const input = document.getElementById(button.dataset.passwordToggle);
        if (!input) return;
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        button.setAttribute('aria-pressed', String(reveal));
        button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
        button.textContent = reveal ? 'Hide' : 'Show';
      });
    });
  }

  function fieldError(form, name, message = '') {
    const input = form.elements.namedItem(name);
    const error = form.querySelector(`[data-error-for="${name}"]`);
    if (input) input.setAttribute('aria-invalid', String(Boolean(message)));
    if (error) error.textContent = message;
  }

  function clearFormErrors(form) {
    form.querySelectorAll('[data-error-for]').forEach((element) => { element.textContent = ''; });
    form.querySelectorAll('[aria-invalid="true"]').forEach((element) => element.setAttribute('aria-invalid', 'false'));
  }

  function setBusy(form, busy, label) {
    const button = form.querySelector('[type="submit"]');
    const text = button?.querySelector('[data-submit-label]');
    if (!button || !text) return;
    if (busy) {
      button.dataset.originalLabel = text.textContent;
      text.textContent = label;
      button.disabled = true;
      button.classList.add('is-loading');
      button.setAttribute('aria-busy', 'true');
    } else {
      text.textContent = button.dataset.originalLabel || label;
      button.disabled = false;
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
    }
  }

  function validateSignup(form) {
    clearFormErrors(form);
    const values = Object.fromEntries(new FormData(form).entries());
    let firstInvalid = null;
    const fail = (field, message) => {
      fieldError(form, field, message);
      firstInvalid ||= form.elements.namedItem(field);
    };
    const required = ['fullName', 'username', 'email', 'phone', 'password', 'confirmPassword', 'dateOfBirth'];
    required.forEach((field) => {
      if (!String(values[field] || '').trim()) fail(field, 'This field is required.');
    });
    if (values.fullName?.trim() && values.fullName.trim().length < 2) fail('fullName', 'Enter your full name.');
    if (values.username?.trim() && !/^[a-zA-Z0-9_]{3,20}$/.test(values.username.trim())) fail('username', 'Use 3-20 letters, numbers, or underscores.');
    if (values.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email.trim())) fail('email', 'Enter a valid email address.');
    if (values.phone?.trim()) {
      const digits = values.phone.replace(/\D/g, '');
      if (!/^\+?[0-9\s()-]+$/.test(values.phone.trim()) || digits.length < 10 || digits.length > 15) fail('phone', 'Enter a valid mobile number with 10-15 digits.');
    }
    if (values.password && values.password.length < 8) fail('password', 'Use at least 8 characters.');
    if (values.confirmPassword && values.password !== values.confirmPassword) fail('confirmPassword', 'Passwords do not match.');
    if (values.dateOfBirth && (Number.isNaN(Date.parse(values.dateOfBirth)) || new Date(values.dateOfBirth) > new Date())) fail('dateOfBirth', 'Enter a valid date in the past.');
    if (!form.elements.namedItem('terms').checked) fail('terms', 'Accept the terms to create your account.');
    return { valid: !firstInvalid, firstInvalid, values };
  }

  function setupSignupForm() {
    const form = document.querySelector('#signup-form');
    if (!form) return;
    const message = document.querySelector('.auth-message');
    form.addEventListener('input', (event) => {
      if (event.target.name) fieldError(form, event.target.name);
      if (event.target.name === 'password') fieldError(form, 'confirmPassword');
    });
    form.addEventListener('change', (event) => {
      if (event.target.name) fieldError(form, event.target.name);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const validation = validateSignup(form);
      if (!validation.valid) {
        validation.firstInvalid?.focus();
        return;
      }
      setBusy(form, true, 'Creating account...');
      const result = await registerUser({
        fullName: validation.values.fullName,
        username: validation.values.username,
        email: validation.values.email,
        phone: validation.values.phone,
        password: validation.values.password,
        dateOfBirth: validation.values.dateOfBirth
      });
      if (!result.success) {
        if (result.field) {
          fieldError(form, result.field, result.message);
          form.elements.namedItem(result.field).focus();
        } else {
          showMessage(message, result.message);
        }
        setBusy(form, false, 'Create account');
        return;
      }
      saveNotice(`Welcome to ARENA X, ${result.user.username}. Your account is ready.`, 'success');
      location.assign('index.html');
    });
  }

  function setupLoginForm() {
    const form = document.querySelector('#login-form');
    if (!form) return;
    const message = document.querySelector('.auth-message');
    const params = new URLSearchParams(location.search);
    const notice = consumeNotice();
    if (notice) showMessage(message, notice.message, notice.type);
    else if (params.has('required')) showMessage(message, 'Log in is required to view your profile.', 'info');

    form.addEventListener('input', (event) => {
      if (event.target.name) fieldError(form, event.target.name);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormErrors(form);
      const data = new FormData(form);
      const identifier = String(data.get('identifier') || '').trim();
      const password = String(data.get('password') || '');
      let invalid = false;
      if (!identifier) { fieldError(form, 'identifier', 'Enter your email or username.'); invalid = true; }
      if (!password) { fieldError(form, 'password', 'Enter your password.'); invalid = true; }
      if (invalid) {
        form.querySelector('[aria-invalid="true"]')?.focus();
        return;
      }
      setBusy(form, true, 'Logging in...');
      const result = await loginUser(identifier, password);
      if (!result.success) {
        showMessage(message, result.message);
        setBusy(form, false, 'Log in');
        return;
      }
      saveNotice(`Welcome back, ${result.user.username}.`, 'success');
      location.assign(takeReturnTarget());
    });
  }

  function setupAuthNavigation() {
    const toggle = document.querySelector('.menu-toggle');
    const nav = document.querySelector('.primary-nav');
    toggle?.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      toggle.setAttribute('aria-label', open ? 'Open navigation' : 'Close navigation');
      nav?.classList.toggle('is-open', !open);
    });
    nav?.addEventListener('click', (event) => {
      if (!event.target.closest('a')) return;
      nav.classList.remove('is-open');
      toggle?.setAttribute('aria-expanded', 'false');
      toggle?.setAttribute('aria-label', 'Open navigation');
    });
    document.addEventListener('click', (event) => {
      const action = event.target.closest('[data-auth-action]')?.dataset.authAction;
      if (action === 'logout') {
        event.preventDefault();
        actionLogout();
      } else if (action === 'forgot-password') {
        event.preventDefault();
        showMessage(document.querySelector('.auth-message'), 'Password recovery is not available yet.', 'info');
      }
    });

    async function actionLogout() {
      const result = await logoutUser();
      saveNotice(result.success ? 'You have been logged out.' : 'You were signed out here, but the authentication service could not confirm server logout.', result.success ? 'info' : 'error');
      location.assign('index.html');
    }
  }

  const authEntryPage = ['login.html', 'signup.html'].includes(location.pathname.split('/').pop());
  removeLegacyCredentials();
  const ready = authEntryPage
    ? Promise.resolve().then(() => { sessionChecked = true; return null; })
    : checkSession();
  const api = Object.freeze({
    ready,
    checkSession,
    sessionError: () => sessionError,
    isLoggedIn,
    getCurrentUser,
    getUsers,
    getUserById,
    findUserByUsername,
    loginUser,
    logoutUser,
    registerUser,
    updateUser,
    requireLogin,
    requireAdmin,
    isAdmin,
    getCurrentUserRole,
    consumeNotice,
    saveNotice,
    saveReturnTarget,
    takeReturnTarget
  });
  globalThis.ArenaAuth = api;

  if (document.body.dataset.protected === 'true' || document.body.dataset.page === 'admin') {
    document.documentElement.style.visibility = 'hidden';
  }
  attachPasswordToggles();
  setupAuthNavigation();
  setupSignupForm();
  setupLoginForm();
  ready.then(async () => {
    ensureTournamentNavigation();
    renderHeaderAccount();
    document.dispatchEvent(new CustomEvent('arena:session-ready', { detail: { authenticated: isLoggedIn() } }));
    if (document.body.dataset.protected === 'true') {
      if (await requireLogin()) {
        document.documentElement.style.visibility = '';
        renderProfile();
      }
    }
  });
  async function refreshSession() {
    if (!isLoggedIn()) return;
    await checkSession();
    renderHeaderAccount();
    ensureTournamentNavigation();
    if (isLoggedIn()) return;
    if (document.body.dataset.protected === 'true') await requireLogin();
    else showToast(sessionError?.code === 'UNAUTHORIZED'
      ? 'Your session is no longer valid. Log in again to continue.'
      : 'Your session could not be verified because the authentication service is unavailable.');
  }
  window.setInterval?.(refreshSession, 300000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshSession();
  });
})();
