(() => {
  const auth = globalThis.ArenaAuth;
  if (!auth) return;
  auth.ready.then(() => {
  const tournaments = globalThis.ArenaTournaments;
  const teams = globalThis.ArenaTeams;
  const matches = globalThis.ArenaMatches;
  const leaderboard = globalThis.ArenaLeaderboard;
  const notifications = globalThis.ArenaNotifications;
  const user = auth?.getCurrentUser();
  const content = document.querySelector('#profile-content');
  if (!user || !content || !tournaments || !teams || !matches || !leaderboard) return;

  if (!tournaments.getMyTournamentsAvailable() || !teams.areTournamentRegistrationsAvailable() || !matches.getMyMatchesAvailable()) {
    content.querySelector('#profile-dashboard')?.remove();
    const dashboard = document.createElement('section');
    dashboard.className = 'profile-dashboard-section';
    dashboard.id = 'profile-dashboard';
    dashboard.innerHTML = '<div class="profile-dashboard-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> COMPETITION DATA</p><h2>History <span>unavailable.</span></h2></div></div><p class="dashboard-empty-copy">The current backend API does not list your tournament registrations, team history, or personal matches. No local competition records are used as a fallback.</p>';
    content.querySelector('.profile-stats')?.after(dashboard);
    const clearLocalStats = () => document.querySelectorAll('[data-profile-stat]').forEach((element) => { element.textContent = '—'; });
    clearLocalStats();
    window.setTimeout(clearLocalStats, 0);
    return;
  }

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const dateLabel = (value) => value ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`)) : 'Date pending';
  const dateTimeLabel = (value) => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Date not recorded';

  const joinedTournaments = tournaments.getMyTournaments();
  const registrations = tournaments.getUserTournamentRegistrations(user.userId);
  const joinedTeamIds = new Set(registrations.map((registration) => registration.teamId).filter(Boolean));
  const userTeams = teams.getTeams().filter((team) => team.status === 'active' && team.members?.some((member) => member.userId === user.userId));
  userTeams.forEach((team) => joinedTeamIds.add(team.teamId));
  const myMatches = matches.getMyMatches(user.userId);
  const upcomingMatches = myMatches.filter((match) => match.status === 'upcoming');
  const liveMatches = myMatches.filter((match) => match.status === 'live');
  const completedMatches = myMatches.filter((match) => match.status === 'completed');
  const leaderboardRows = leaderboard.getLeaderboard({ tournamentId: 'all', game: 'all' })
    .sort((first, second) => second.totalPoints - first.totalPoints)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const personalStanding = leaderboardRows.find((row) => row.playerId === user.userId);
  const teamStandings = leaderboardRows.filter((row) => row.teamId && joinedTeamIds.has(row.teamId));
  const ownStanding = personalStanding || teamStandings[0] || null;
  const tournamentCounts = {
    joined: joinedTournaments.length,
    upcoming: joinedTournaments.filter((tournament) => tournament.status === 'Upcoming').length,
    active: joinedTournaments.filter((tournament) => tournament.status === 'Live').length,
    completed: joinedTournaments.filter((tournament) => tournament.status === 'Completed').length
  };

  const statValues = {
    wins: ownStanding?.wins ?? (Number(user.wins) || 0),
    matches: ownStanding?.matchesPlayed ?? (completedMatches.length || Number(user.matches) || 0),
    kills: ownStanding?.kills ?? (Number(user.kills) || 0),
    points: ownStanding?.totalPoints ?? (Number(user.points) || 0)
  };
  document.querySelectorAll('[data-profile-stat]').forEach((element) => {
    element.textContent = String(statValues[element.dataset.profileStat] ?? 0);
  });

  function participantResult(match) {
    const registrationsForUser = tournaments.getUserTournamentRegistrations(user.userId)
      .filter((registration) => registration.tournamentId === match.tournamentId);
    const teamIds = new Set([...joinedTeamIds, ...registrationsForUser.map((registration) => registration.teamId).filter(Boolean)]);
    return (match.results || []).filter((result) => result.playerId === user.userId || (result.teamId && teamIds.has(result.teamId)));
  }

  const resultHistory = completedMatches.flatMap((match) => participantResult(match).map((result) => ({ match, result })))
    .sort((first, second) => new Date(second.match.updatedAt || second.match.createdAt) - new Date(first.match.updatedAt || first.match.createdAt));

  function activityFeed() {
    const activity = [];
    registrations.forEach((registration) => {
      const tournament = tournaments.getTournamentById(registration.tournamentId);
      if (tournament && registration.registeredAt) activity.push({ type: 'TOURNAMENT', title: 'Tournament joined', description: tournament.name, date: registration.registeredAt, href: `tournament.html?id=${encodeURIComponent(tournament.id)}` });
    });
    userTeams.forEach((team) => {
      if (team.ownerId === user.userId) {
        if (team.createdAt) activity.push({ type: 'TEAM', title: 'Team created', description: `${team.teamName} [${team.teamTag}]`, date: team.createdAt, href: `team.html?id=${encodeURIComponent(team.teamId)}` });
        team.members.filter((member) => member.userId !== user.userId && member.joinedAt).forEach((member) => {
          activity.push({ type: 'TEAM', title: 'Player joined team', description: `${member.username} joined ${team.teamName}.`, date: member.joinedAt, href: `team.html?id=${encodeURIComponent(team.teamId)}` });
        });
      } else {
        const membership = team.members.find((member) => member.userId === user.userId);
        if (membership?.joinedAt) activity.push({ type: 'TEAM', title: 'Team joined', description: `${team.teamName} [${team.teamTag}]`, date: membership.joinedAt, href: `team.html?id=${encodeURIComponent(team.teamId)}` });
      }
    });
    resultHistory.forEach(({ match, result }) => {
      const tournament = tournaments.getTournamentById(match.tournamentId);
      const date = match.updatedAt || match.createdAt;
      if (!date || match.resultStatus !== 'published') return;
      activity.push({ type: 'RESULT', title: 'Match result published', description: `${tournament?.name || 'Tournament'} · ${match.title}`, date, href: `match.html?id=${encodeURIComponent(match.matchId)}`, points: Number(result.points) || 0, kills: Number(result.kills) || 0 });
    });
    return activity.sort((first, second) => new Date(second.date) - new Date(first.date)).slice(0, 6);
  }

  function teamSummary() {
    if (!userTeams.length) return '<p class="dashboard-empty-copy">No team joined yet.</p>';
    return userTeams.map((team) => {
      const member = team.members.find((entry) => entry.userId === user.userId);
      const standing = teamStandings.find((entry) => entry.teamId === team.teamId);
      const standingLabel = standing ? `Team rank #${standing.rank} · ${standing.totalPoints} points · ${standing.wins} wins` : 'No team match results yet.';
      return `<a class="dashboard-team-row" href="team.html?id=${encodeURIComponent(team.teamId)}"><span><strong>${escapeHtml(team.teamName)} <em>[${escapeHtml(team.teamTag)}]</em></strong><small>${escapeHtml(member?.role || 'MEMBER')} · ${team.members.length} members</small><small>${standingLabel}</small></span><span aria-hidden="true">↗</span></a>`;
    }).join('');
  }

  function tournamentHistory() {
    if (!joinedTournaments.length) return '<p class="dashboard-empty-copy">No tournaments joined yet.</p>';
    return [...joinedTournaments].sort((first, second) => second.startDate.localeCompare(first.startDate)).slice(0, 4).map((tournament) => `<a class="dashboard-list-row" href="tournament.html?id=${encodeURIComponent(tournament.id)}"><span><strong>${escapeHtml(tournament.name)}</strong><small>${escapeHtml(tournament.game)} · ${escapeHtml(tournament.mode)} · ${dateLabel(tournament.startDate)}</small></span><span class="card-status status-${escapeHtml(tournament.status.toLowerCase())}">${escapeHtml(tournament.status.toUpperCase())}</span></a>`).join('');
  }

  function matchHistory() {
    const recent = [...myMatches].sort((first, second) => `${second.date} ${second.startTime}`.localeCompare(`${first.date} ${first.startTime}`)).slice(0, 4);
    if (!recent.length) return '<p class="dashboard-empty-copy">No matches yet.</p>';
    return recent.map((match) => {
      const tournament = tournaments.getTournamentById(match.tournamentId);
      const result = participantResult(match)[0];
      const registration = tournaments.getUserTournamentRegistrations(user.userId).find((entry) => entry.tournamentId === match.tournamentId);
      const team = registration?.teamId ? teams.getTeamById(registration.teamId) : null;
      const participant = team ? `${team.teamName} [${team.teamTag}]` : user.username;
      const resultLabel = result ? `Place ${Number(result.placement) || '—'} · ${Number(result.points) || 0} pts · ${Number(result.kills) || 0} kills` : `${escapeHtml(match.game)} · ${escapeHtml(match.mode)}`;
      return `<article class="dashboard-list-row"><span><strong>${escapeHtml(tournament?.name || 'Tournament')} · Match ${String(match.matchNumber).padStart(2, '0')}</strong><small>${escapeHtml(participant)} · ${escapeHtml(match.game)} · ${escapeHtml(match.mode)} · ${dateLabel(match.date)} · ${escapeHtml(match.startTime)} · ${escapeHtml(resultLabel)}</small></span><a class="card-status status-${escapeHtml(match.status)}" href="match.html?id=${encodeURIComponent(match.matchId)}">${escapeHtml(match.status.toUpperCase())} ↗</a></article>`;
    }).join('');
  }

  function activityMarkup() {
    const activity = activityFeed();
    if (!activity.length) return '<p class="dashboard-empty-copy">No recent activity.</p>';
    return activity.map((item) => `<a class="dashboard-activity-row" href="${item.href}"><span class="dashboard-activity-type">${escapeHtml(item.type)}</span><span class="dashboard-activity-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description)}${item.points === undefined ? '' : ` · ${item.points} points · ${item.kills} kills`}</small></span><time>${escapeHtml(dateTimeLabel(item.date))}</time></a>`).join('');
  }

  function notificationPreview() {
    const items = notifications?.getNotifications(user.userId).filter((item) => !item.read).slice(0, 3) || [];
    if (!items.length) return '<p class="dashboard-empty-copy">No notifications.</p>';
    return items.map((item) => `<a class="dashboard-notification-row" href="notifications.html"><span class="notification-unread-dot" aria-hidden="true"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message)}</small></span></a>`).join('');
  }

  const dashboard = document.createElement('div');
  dashboard.className = 'profile-dashboard';
  dashboard.id = 'profile-dashboard';
  dashboard.innerHTML = `<section class="profile-dashboard-section profile-dashboard-overview"><div class="profile-dashboard-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> PLAYER OVERVIEW</p><h2>Season <span>activity.</span></h2></div><a class="button button-outline" href="notifications.html">Notifications <span class="dashboard-notification-count">${notifications?.getUnreadCount(user.userId) || 0}</span> <span aria-hidden="true">↗</span></a></div>
      <div class="profile-dashboard-metrics"><div><strong>${tournamentCounts.joined}</strong><span>TOURNAMENTS</span></div><div><strong>${userTeams.length}</strong><span>TEAMS</span></div><div><strong>${myMatches.length}</strong><span>MATCHES</span></div><div><strong>${ownStanding?.totalPoints || 0}</strong><span>LEADERBOARD POINTS</span></div></div>
      <div class="dashboard-quick-actions"><a href="tournaments.html">Browse Tournaments <span aria-hidden="true">↗</span></a><a href="my-tournaments.html">My Tournaments <span aria-hidden="true">↗</span></a><a href="my-team.html">Create / Join Team <span aria-hidden="true">↗</span></a><a href="matches.html">Matches <span aria-hidden="true">↗</span></a><a href="leaderboard.html">Leaderboard <span aria-hidden="true">↗</span></a><a href="wallet.html">Wallet <span aria-hidden="true">↗</span></a><a href="profile.html">Profile <span aria-hidden="true">↗</span></a><a href="notifications.html">Notifications <span aria-hidden="true">↗</span></a></div></section>
      <div class="profile-dashboard-grid"><section class="profile-dashboard-section"><div class="profile-dashboard-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> YOUR ENTRIES</p><h2>Tournament <span>run.</span></h2></div><a class="dashboard-section-link" href="my-tournaments.html">All entries ↗</a></div><div class="dashboard-tournament-stats"><div><strong>${tournamentCounts.upcoming}</strong><span>UPCOMING</span></div><div><strong>${tournamentCounts.active}</strong><span>ACTIVE</span></div><div><strong>${tournamentCounts.completed}</strong><span>COMPLETED</span></div></div><div class="dashboard-list">${tournamentHistory()}</div></section>
        <section class="profile-dashboard-section"><div class="profile-dashboard-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> TEAM HQ</p><h2>Your <span>team.</span></h2></div><a class="dashboard-section-link" href="my-team.html">Create / Join ↗</a></div><div class="dashboard-team-list">${teamSummary()}</div></section>
        <section class="profile-dashboard-section"><div class="profile-dashboard-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> NEXT DROP</p><h2>Match <span>summary.</span></h2></div><a class="dashboard-section-link" href="matches.html">All matches ↗</a></div><div class="dashboard-match-stats"><span>${upcomingMatches.length} upcoming</span><span>${liveMatches.length} live</span><span>${completedMatches.length} completed</span></div><div class="dashboard-list">${matchHistory()}</div></section>
        <section class="profile-dashboard-section"><div class="profile-dashboard-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> EARNED STANDING</p><h2>Leaderboard <span>stats.</span></h2></div><a class="dashboard-section-link" href="leaderboard.html">Full leaderboard ↗</a></div>${ownStanding ? `<div class="dashboard-standing-rank"><strong>#${ownStanding.rank}</strong><span>${escapeHtml(ownStanding.entityType === 'team' ? ownStanding.teamName : ownStanding.playerName)}</span></div><div class="dashboard-standing-stats"><div><strong>${ownStanding.totalPoints}</strong><span>TOTAL POINTS</span></div><div><strong>${ownStanding.wins}</strong><span>WINS</span></div><div><strong>${ownStanding.kills}</strong><span>KILLS</span></div><div><strong>${ownStanding.matchesPlayed}</strong><span>MATCHES</span></div><div><strong>${ownStanding.placement ?? '—'}</strong><span>BEST PLACE</span></div></div>` : '<p class="dashboard-empty-copy">No leaderboard results yet.</p>'}</section>
        <section class="profile-dashboard-section"><div class="profile-dashboard-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> RECENT ACTIVITY</p><h2>Latest <span>moves.</span></h2></div></div><div class="dashboard-activity-list">${activityMarkup()}</div></section>
        <section class="profile-dashboard-section"><div class="profile-dashboard-section-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> INBOX</p><h2>Notifications <span>(${notifications?.getUnreadCount(user.userId) || 0})</span></h2></div><a class="dashboard-section-link" href="notifications.html">All notifications ↗</a></div><div id="profile-notifications-preview" class="dashboard-notification-list">${notificationPreview()}</div></section></div>`;
  content.querySelector('#profile-dashboard')?.remove();
  content.querySelector('.profile-stats')?.after(dashboard);
  });
})();