(() => {
  const USERS_KEY = 'arena-x-users-v1';
  const SESSION_KEY = 'arena-x-session-v1';
  const NOTICE_KEY = 'arena-x-notice-v1';
  const RETURN_KEY = 'arena-x-return-v1';
  const PENDING_TOURNAMENT_KEY = 'arenaX_pendingTournament';
  const NOTIFICATIONS_KEY = 'arenaX_notifications';
  const DEMO_USERNAME = 'demo';
  const DEMO_PASSWORD = 'Demo@12345';

  function isUserRecord(user) {
    return Boolean(user && typeof user === 'object' && !Array.isArray(user)
      && typeof user.userId === 'string' && user.userId.trim()
      && typeof user.username === 'string' && user.username.trim()
      && typeof user.password === 'string');
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
      createdAt: user.createdAt,
      role: user.role || (user.isDemo ? 'admin' : 'user'),
      status: user.status === 'suspended' ? 'suspended' : 'active'
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

  // Demo credentials remain in localStorage; production authentication and password hashing must be server-side.
  function createUserRecord(profile) {
    const initials = profile.fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    return {
      userId: globalThis.crypto?.randomUUID?.() || `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      fullName: profile.fullName.trim(),
      username: profile.username.trim(),
      email: profile.email.trim().toLowerCase(),
      phone: profile.phone.trim(),
      password: profile.password,
      dateOfBirth: profile.dateOfBirth,
      avatar: initials || 'AX',
      joinedTournaments: [],
      teamId: null,
      wins: 0,
      matches: 0,
      kills: 0,
      points: 0,
      walletBalance: 0,
      createdAt: new Date().toISOString(),
      isDemo: false,
      role: 'user',
      status: 'active'
    };
  }

  function createDemoAdminRecord() {
    const user = createUserRecord({
      fullName: 'ARENA X Demo Player',
      username: DEMO_USERNAME,
      email: 'demo@arenax.local',
      phone: '0000000000',
      password: DEMO_PASSWORD,
      dateOfBirth: '2000-01-01'
    });
    return { ...user, isDemo: true, role: 'admin' };
  }

  function ensureDemoAccount() {
    const state = readUsersState();
    if (!state.valid) return;
    const users = state.users;
    const existingIndex = users.findIndex((user) => user.username?.toLowerCase() === DEMO_USERNAME);
    if (existingIndex >= 0) {
      const existing = users[existingIndex];
      const isDemoAdmin = Boolean(existing.isDemo || existing.role === 'admin');
      const normalized = {
        ...existing,
        role: isDemoAdmin ? 'admin' : existing.role || 'user',
        isDemo: isDemoAdmin,
        status: ['active', 'suspended'].includes(existing.status) ? existing.status : 'active'
      };
      if (normalized.role !== existing.role || normalized.status !== existing.status) {
        users[existingIndex] = normalized;
        writeUsers(users);
      }
      return;
    }
    users.push(createDemoAdminRecord());
    writeUsers(users);
  }

  function getCurrentUserRecord() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      const now = Date.now();
      const maximumSessionExpiry = now + 30 * 24 * 60 * 60 * 1000;
      if (!session || typeof session !== 'object' || Array.isArray(session)
        || typeof session.userId !== 'string' || !session.userId.trim()
        || typeof session.expiresAt !== 'number' || !Number.isFinite(session.expiresAt)
        || session.expiresAt <= now || session.expiresAt > maximumSessionExpiry) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      const user = findStoredUserById(session.userId);
      if (!user || user.status === 'suspended') localStorage.removeItem(SESSION_KEY);
      if (user?.status === 'suspended') return null;
      return user || null;
    } catch {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  function getCurrentUser() {
    return sanitizeUser(getCurrentUserRecord(), true);
  }

  function isLoggedIn() {
    return getCurrentUserRecord() !== null;
  }

  function loginUser(identifier, password, rememberMe = false) {
    const normalized = String(identifier || '').trim().toLowerCase();
    const user = readUsers().find((entry) => entry.username?.toLowerCase() === normalized || entry.email?.toLowerCase() === normalized);
    if (user?.status === 'suspended') return { success: false, message: 'This account is suspended. Contact ARENA X support.' };
    if (!user || user.password !== password) {
      return { success: false, message: 'That username/email and password combination was not recognized.' };
    }
    const duration = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.userId, rememberMe, expiresAt: Date.now() + duration }));
    } catch {
      return { success: false, message: 'Your browser could not save the login session. Check local storage settings.' };
    }
    return { success: true, user: sanitizeUser(user, true) };
  }

  function registerUser(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return { success: false, message: 'Enter valid account details.' };
    }
    const users = readUsers();
    const fullName = String(profile.fullName || '').trim();
    const username = String(profile.username || '').trim();
    const email = String(profile.email || '').trim().toLowerCase();
    const phone = String(profile.phone || '').trim();
    const password = String(profile.password || '');
    const dateOfBirth = String(profile.dateOfBirth || '');
    if (fullName.length < 2 || !/^[a-zA-Z0-9_]{3,20}$/.test(username)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !phone || password.length < 8
      || !dateOfBirth || Number.isNaN(Date.parse(dateOfBirth)) || new Date(dateOfBirth) > new Date()) {
      return { success: false, message: 'Enter valid account details.' };
    }
    if (users.some((user) => user.username?.toLowerCase() === username.toLowerCase())) {
      return { success: false, field: 'username', message: 'That username is already in use.' };
    }
    if (users.some((user) => user.email?.toLowerCase() === email)) {
      return { success: false, field: 'email', message: 'That email address is already registered.' };
    }
    const user = createUserRecord({ fullName, username, email, phone, password, dateOfBirth });
    if (!writeUsers([...users, user])) {
      return { success: false, message: 'Your browser could not save this account. Check local storage settings.' };
    }
    return { success: true, user: sanitizeUser(user, true) };
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

    const profileFields = new Set(['fullName', 'username', 'email', 'phone', 'dateOfBirth', 'avatar', 'password']);
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
    if (cleanUpdates.password !== undefined && cleanUpdates.password.length < 8) return { success: false, field: 'password', message: 'Use at least 8 characters.' };
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

  function setUserStatus(userId, status) {
    if (!isAdmin()) return { success: false, message: 'Admin access required.' };
    if (!['active', 'suspended'].includes(status)) return { success: false, message: 'Choose a valid account status.' };
    if (userId === getCurrentUserRecord()?.userId && status === 'suspended') return { success: false, message: 'You cannot suspend the current admin account.' };
    const users = readUsers();
    const index = users.findIndex((user) => user.userId === userId);
    if (index < 0) return { success: false, message: 'User not found.' };
    users[index] = { ...users[index], status };
    if (!writeUsers(users)) return { success: false, message: 'Your browser could not save this update.' };
    return { success: true, user: sanitizeUser(users[index], true) };
  }

  function getLegacyWalletBalance(userId) {
    const user = getCurrentUserRecord();
    if (!user || user.userId !== userId) return 0;
    const balance = Number(user.walletBalance);
    return Number.isFinite(balance) && balance >= 0 ? balance : 0;
  }

  function logoutUser() {
    try {
      localStorage.removeItem(SESSION_KEY);
      return true;
    } catch {
      return false;
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

  function requireLogin() {
    if (isLoggedIn()) return true;
    const page = location.pathname.split('/').pop();
    const teamId = page === 'team.html' ? new URLSearchParams(location.search).get('id') : null;
    const target = page === 'team.html'
      ? (teamId && /^[a-z0-9_-]+$/i.test(teamId) ? `team.html?id=${teamId}` : 'my-team.html')
      : ['profile.html', 'my-tournaments.html', 'my-team.html', 'notifications.html', 'wallet.html', 'admin.html'].includes(page) ? page : 'index.html';
    saveReturnTarget(target);
    const message = page === 'profile.html' ? 'Log in is required to view your profile.'
        : page === 'notifications.html' ? 'Log in is required to view your notifications.'
          : page === 'wallet.html' ? 'Log in is required to view your wallet.'
        : page === 'admin.html' ? 'Log in to request local demo admin access.'
        : 'Log in is required to view your team.';
    saveNotice(message, 'info');
    location.replace('login.html');
    return false;
  }

  function getCurrentUserRole() {
    return getCurrentUserRecord()?.role === 'admin' ? 'admin' : 'user';
  }

  function isAdmin() {
    return getCurrentUserRole() === 'admin';
  }

  function requireAdmin() {
    if (isAdmin()) return true;
    if (!isLoggedIn()) {
      saveReturnTarget('admin.html');
      saveNotice('Log in with the local demo admin account to open Admin.', 'info');
      location.replace('login.html');
      return false;
    }
    saveNotice('Admin access is restricted to the local demo admin account.', 'info');
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
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      const result = registerUser({
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
      const login = loginUser(result.user.username, validation.values.password, true);
      if (!login.success) {
        showMessage(message, login.message);
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
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      const result = loginUser(identifier, password, data.has('rememberMe'));
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
        logoutUser();
        saveNotice('You have been logged out.', 'info');
        location.assign('index.html');
      } else if (action === 'forgot-password') {
        event.preventDefault();
        showMessage(document.querySelector('.auth-message'), 'Password recovery is unavailable for local demo accounts. Create a new account or use the DEMO ONLY credentials.', 'info');
      } else if (action === 'fill-demo') {
        event.preventDefault();
        const login = document.querySelector('#login-form');
        if (login) {
          login.elements.namedItem('identifier').value = DEMO_USERNAME;
          login.elements.namedItem('password').value = DEMO_PASSWORD;
          fieldError(login, 'identifier');
          fieldError(login, 'password');
        }
      }
    });
  }

  ensureDemoAccount();
  const api = Object.freeze({
    isLoggedIn,
    getCurrentUser,
    getUsers,
    getUserById,
    findUserByUsername,
    loginUser,
    logoutUser,
    registerUser,
    updateUser,
    setUserStatus,
    getLegacyWalletBalance,
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

  ensureTournamentNavigation();
  renderHeaderAccount();
  attachPasswordToggles();
  setupAuthNavigation();
  setupSignupForm();
  setupLoginForm();

  if (document.body.dataset.protected === 'true' && requireLogin()) renderProfile();
})();
