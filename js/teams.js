// Team records are a local demo only. Production team and invitation changes require server authorization and durable storage.
(() => {
  const TEAMS_KEY = 'arenaX_teams';
  const INVITATIONS_KEY = 'arenaX_teamInvitations';
  const MAX_TEAM_SIZE = 4;

  function isValidMember(member) {
    return Boolean(member && typeof member === 'object' && !Array.isArray(member)
      && typeof member.userId === 'string' && member.userId.trim()
      && typeof member.username === 'string' && member.username.trim()
      && (member.fullName === undefined || typeof member.fullName === 'string')
      && (member.role === undefined || typeof member.role === 'string')
      && (member.joinedAt === undefined || (typeof member.joinedAt === 'string' && Number.isFinite(Date.parse(member.joinedAt)))));
  }

  function isValidTeam(team) {
    return Boolean(team && typeof team === 'object' && !Array.isArray(team)
      && typeof team.teamId === 'string' && /^[a-z0-9_-]+$/i.test(team.teamId)
      && typeof team.teamName === 'string' && team.teamName.trim()
      && typeof team.teamTag === 'string' && team.teamTag.trim()
      && typeof team.ownerId === 'string' && team.ownerId.trim()
      && Array.isArray(team.members) && team.members.length <= MAX_TEAM_SIZE && team.members.every(isValidMember)
      && (team.status === undefined || typeof team.status === 'string'));
  }

  function isValidInvitation(invitation) {
    return Boolean(invitation && typeof invitation === 'object' && !Array.isArray(invitation)
      && typeof invitation.invitationId === 'string' && invitation.invitationId.trim()
      && typeof invitation.teamId === 'string' && invitation.teamId.trim()
      && typeof invitation.teamName === 'string'
      && typeof invitation.senderId === 'string' && invitation.senderId.trim()
      && typeof invitation.receiverId === 'string' && invitation.receiverId.trim()
      && ['PENDING', 'ACCEPTED', 'DECLINED'].includes(invitation.status)
      && typeof invitation.createdAt === 'string' && Number.isFinite(Date.parse(invitation.createdAt)));
  }

  function hasInvalidStoredRecords(key, validator) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return false;
      const parsed = JSON.parse(raw);
      return !Array.isArray(parsed) || !parsed.every(validator);
    } catch {
      return true;
    }
  }

  function readArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function writeArray(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function getTeams() {
    return readArray(TEAMS_KEY).filter(isValidTeam);
  }

  function saveTeams(teams) {
    if (!Array.isArray(teams) || !teams.every(isValidTeam) || hasInvalidStoredRecords(TEAMS_KEY, isValidTeam)) return false;
    return writeArray(TEAMS_KEY, teams);
  }

  function getInvitations() {
    return readArray(INVITATIONS_KEY).filter(isValidInvitation);
  }

  function saveInvitations(invitations) {
    if (!Array.isArray(invitations) || !invitations.every(isValidInvitation)
      || hasInvalidStoredRecords(INVITATIONS_KEY, isValidInvitation)) return false;
    return writeArray(INVITATIONS_KEY, invitations);
  }

  function getCurrentUser() {
    return globalThis.ArenaAuth?.getCurrentUser() || null;
  }

  function getTeamById(teamId) {
    if (typeof teamId !== 'string' || !/^[a-z0-9_-]+$/i.test(teamId)) return null;
    return getTeams().find((team) => team.teamId === teamId) || null;
  }

  function getUserTeam(userId = getCurrentUser()?.userId) {
    if (!userId) return null;
    return getTeams().find((team) => team.status === 'active' && team.members.some((member) => member.userId === userId)) || null;
  }

  function getTeamStats(teamId) {
    const team = getTeamById(teamId);
    if (!team) return { tournamentsJoined: 0, wins: 0, matches: 0, kills: 0, points: 0 };
    const registrations = globalThis.ArenaTournaments?.getParticipants?.() || [];
    return {
      tournamentsJoined: registrations.filter((registration) => registration.teamId === teamId && registration.status !== 'cancelled').length,
      wins: Number(team.stats?.wins || 0),
      matches: Number(team.stats?.matches || 0),
      kills: Number(team.stats?.kills || 0),
      points: Number(team.stats?.points || 0)
    };
  }

  function createId(prefix) {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`}`;
  }

  function validateTeamNameAndTag(teamName, teamTag, excludedTeamId = null) {
    const name = String(teamName || '').trim();
    const tag = String(teamTag || '').trim().toUpperCase();
    if (name.length < 3) return { valid: false, field: 'teamName', message: 'Team name must be at least 3 characters.' };
    if (name.length > 32) return { valid: false, field: 'teamName', message: 'Team name must be 32 characters or fewer.' };
    if (!/^[A-Z0-9]{2,6}$/.test(tag)) return { valid: false, field: 'teamTag', message: 'Team tag must be 2-6 letters or numbers.' };
    const duplicateName = getTeams().some((team) => team.teamId !== excludedTeamId && team.teamName.toLowerCase() === name.toLowerCase());
    if (duplicateName) return { valid: false, field: 'teamName', message: 'That team name is already taken.' };
    const duplicateTag = getTeams().some((team) => team.teamId !== excludedTeamId && team.teamTag.toUpperCase() === tag);
    if (duplicateTag) return { valid: false, field: 'teamTag', message: 'That team tag is already taken.' };
    return { valid: true, teamName: name, teamTag: tag };
  }

  function memberFromUser(user, role = 'MEMBER') {
    return {
      userId: user.userId,
      username: user.username,
      fullName: user.fullName,
      avatar: user.avatar || 'AX',
      role,
      joinedAt: new Date().toISOString()
    };
  }

  function createTeam(details) {
    const owner = getCurrentUser();
    if (!owner) return { success: false, reason: 'login', message: 'Log in to create a team.' };
    if (getUserTeam(owner.userId)) return { success: false, reason: 'already-in-team', message: 'Leave your current team before creating another.' };
    const validation = validateTeamNameAndTag(details.teamName, details.teamTag);
    if (!validation.valid) return { success: false, ...validation };
    const teamId = createId('team');
    const team = {
      teamId,
      teamName: validation.teamName,
      teamTag: validation.teamTag,
      logo: String(details.logo || '').trim() || owner.avatar || 'AX',
      description: String(details.description || '').trim().slice(0, 240),
      ownerId: owner.userId,
      members: [memberFromUser(owner, 'CAPTAIN')],
      createdAt: new Date().toISOString(),
      status: 'active',
      stats: { wins: 0, matches: 0, kills: 0, points: 0 }
    };
    const teams = getTeams();
    if (!saveTeams([...teams, team])) return { success: false, reason: 'storage', message: 'Your browser could not save this team.' };
    const updatedUser = globalThis.ArenaAuth.updateUser(owner.userId, { teamId });
    if (!updatedUser.success) {
      saveTeams(teams);
      return { success: false, reason: 'storage', message: updatedUser.message || 'Your browser could not save your team profile.' };
    }
    return { success: true, team };
  }

  function updateTeam(teamId, updates) {
    const currentUser = getCurrentUser();
    const teams = getTeams();
    const index = teams.findIndex((team) => team.teamId === teamId);
    if (index < 0) return { success: false, reason: 'missing', message: 'Team not found.' };
    const team = teams[index];
    if (!currentUser || team.ownerId !== currentUser.userId) return { success: false, reason: 'captain', message: 'Only the captain can edit team details.' };
    const validation = validateTeamNameAndTag(updates.teamName ?? team.teamName, updates.teamTag ?? team.teamTag, teamId);
    if (!validation.valid) return { success: false, ...validation };
    const updatedTeam = {
      ...team,
      teamName: validation.teamName,
      teamTag: validation.teamTag,
      logo: String(updates.logo ?? team.logo).trim().slice(0, 80) || currentUser.avatar || 'AX',
      description: String(updates.description ?? team.description).trim().slice(0, 240)
    };
    teams[index] = updatedTeam;
    if (!saveTeams(teams)) return { success: false, reason: 'storage', message: 'Your browser could not save team changes.' };
    return { success: true, team: updatedTeam };
  }

  function appendMember(teamId, user) {
    const teams = getTeams();
    const index = teams.findIndex((team) => team.teamId === teamId && team.status === 'active');
    if (index < 0) return { success: false, reason: 'missing', message: 'Team not found.' };
    const team = teams[index];
    if (team.members.some((member) => member.userId === user.userId)) return { success: false, reason: 'duplicate', message: 'This player is already on the team.' };
    if (team.members.length >= MAX_TEAM_SIZE) return { success: false, reason: 'full', message: 'This team already has 4 members.' };
    if (getUserTeam(user.userId)) return { success: false, reason: 'has-team', message: 'This player already belongs to a team.' };
    const priorUser = globalThis.ArenaAuth.getUserById(user.userId);
    const updatedTeam = { ...team, members: [...team.members, memberFromUser(user, 'MEMBER')] };
    teams[index] = updatedTeam;
    if (!saveTeams(teams)) return { success: false, reason: 'storage', message: 'Your browser could not save this team change.' };
    const userUpdate = globalThis.ArenaAuth.updateUser(user.userId, { teamId });
    if (!userUpdate.success) {
      saveTeams(getTeams().map((entry) => entry.teamId === teamId ? team : entry));
      return { success: false, reason: 'storage', message: userUpdate.message || 'Your browser could not save this player profile.' };
    }
    return { success: true, team: updatedTeam, member: memberFromUser(priorUser || user, 'MEMBER') };
  }

  function addTeamMember(teamId, userId) {
    const currentUser = getCurrentUser();
    const team = getTeamById(teamId);
    if (!currentUser || !team || team.ownerId !== currentUser.userId) return { success: false, reason: 'captain', message: 'Only the captain can add team members.' };
    const user = globalThis.ArenaAuth.getUserById(userId);
    if (!user) return { success: false, reason: 'missing-user', message: 'Player not found.' };
    return appendMember(teamId, user);
  }

  function removeTeamMember(teamId, userId) {
    const currentUser = getCurrentUser();
    const teams = getTeams();
    const index = teams.findIndex((team) => team.teamId === teamId);
    if (index < 0) return { success: false, reason: 'missing', message: 'Team not found.' };
    const team = teams[index];
    if (!currentUser || team.ownerId !== currentUser.userId) return { success: false, reason: 'captain', message: 'Only the captain can remove members.' };
    if (team.ownerId === userId && team.members.length > 1) return { success: false, reason: 'transfer-required', message: 'Transfer captain first. A captain cannot leave while members remain.' };
    if (team.ownerId === userId) return { success: false, reason: 'leave-team', message: 'Use Leave Team to close your solo team.' };
    const removed = team.members.find((member) => member.userId === userId);
    if (!removed) return { success: false, reason: 'missing-member', message: 'That player is not on this team.' };
    const updatedTeam = { ...team, members: team.members.filter((member) => member.userId !== userId) };
    teams[index] = updatedTeam;
    if (!saveTeams(teams)) return { success: false, reason: 'storage', message: 'Your browser could not save this team change.' };
    const userUpdate = globalThis.ArenaAuth.updateUser(userId, { teamId: null });
    if (!userUpdate.success) {
      saveTeams(teams.map((entry) => entry.teamId === teamId ? team : entry));
      return { success: false, reason: 'storage', message: userUpdate.message || 'Your browser could not update this player.' };
    }
    return { success: true, team: updatedTeam, member: removed };
  }

  function leaveTeam(teamId = getUserTeam()?.teamId) {
    const currentUser = getCurrentUser();
    const teams = getTeams();
    const index = teams.findIndex((team) => team.teamId === teamId && team.members.some((member) => member.userId === currentUser?.userId));
    if (index < 0) return { success: false, reason: 'missing', message: 'You are not on that team.' };
    const team = teams[index];
    if (team.ownerId === currentUser.userId && team.members.length > 1) return { success: false, reason: 'transfer-required', message: 'Transfer captain first. A captain cannot leave while members remain.' };
    const previousTeams = teams;
    const remainingMembers = team.members.filter((member) => member.userId !== currentUser.userId);
    if (team.ownerId === currentUser.userId && remainingMembers.length === 0) teams.splice(index, 1);
    else teams[index] = { ...team, members: remainingMembers };
    if (!saveTeams(teams)) return { success: false, reason: 'storage', message: 'Your browser could not save this change.' };
    const update = globalThis.ArenaAuth.updateUser(currentUser.userId, { teamId: null });
    if (!update.success) {
      saveTeams(previousTeams);
      return { success: false, reason: 'storage', message: update.message || 'Your browser could not update your profile.' };
    }
    return { success: true, team: teams.find((entry) => entry.teamId === teamId) || null };
  }

  function transferCaptain(teamId, nextCaptainId) {
    const currentUser = getCurrentUser();
    const teams = getTeams();
    const index = teams.findIndex((team) => team.teamId === teamId);
    if (index < 0) return { success: false, reason: 'missing', message: 'Team not found.' };
    const team = teams[index];
    if (!currentUser || team.ownerId !== currentUser.userId) return { success: false, reason: 'captain', message: 'Only the captain can transfer captaincy.' };
    if (!team.members.some((member) => member.userId === nextCaptainId)) return { success: false, reason: 'member', message: 'Choose an existing team member.' };
    if (nextCaptainId === currentUser.userId) return { success: false, reason: 'same', message: 'That player is already the captain.' };
    const updatedTeam = {
      ...team,
      ownerId: nextCaptainId,
      members: team.members.map((member) => ({ ...member, role: member.userId === nextCaptainId ? 'CAPTAIN' : 'MEMBER' }))
    };
    teams[index] = updatedTeam;
    if (!saveTeams(teams)) return { success: false, reason: 'storage', message: 'Your browser could not save this captain transfer.' };
    return { success: true, team: updatedTeam };
  }

  function getTeamInvitations(teamId) {
    return getInvitations().filter((invitation) => invitation.teamId === teamId);
  }

  function getUserInvitations(userId = getCurrentUser()?.userId) {
    if (!userId) return [];
    return getInvitations().filter((invitation) => invitation.receiverId === userId && invitation.status === 'PENDING');
  }

  function sendTeamInvitation(teamId, username) {
    const currentUser = getCurrentUser();
    const team = getTeamById(teamId);
    if (!currentUser || !team || team.ownerId !== currentUser.userId) return { success: false, reason: 'captain', message: 'Only the captain can invite players.' };
    if (team.members.length >= MAX_TEAM_SIZE) return { success: false, reason: 'full', message: 'Your team already has 4 members.' };
    const receiver = globalThis.ArenaAuth.findUserByUsername(username);
    if (!receiver) return { success: false, reason: 'missing-user', message: 'No player was found with that username.' };
    if (receiver.userId === currentUser.userId) return { success: false, reason: 'self', message: 'You are already the team captain.' };
    if (getUserTeam(receiver.userId)) return { success: false, reason: 'has-team', message: 'That player already belongs to a team.' };
    const invitations = getInvitations();
    if (invitations.some((invite) => invite.teamId === teamId && invite.receiverId === receiver.userId && invite.status === 'PENDING')) {
      return { success: false, reason: 'duplicate', message: 'This player already has a pending team invitation.' };
    }
    const invitation = {
      invitationId: createId('invite'),
      teamId,
      teamName: team.teamName,
      senderId: currentUser.userId,
      receiverId: receiver.userId,
      createdAt: new Date().toISOString(),
      status: 'PENDING'
    };
    if (!saveInvitations([...invitations, invitation])) return { success: false, reason: 'storage', message: 'Your browser could not save this invitation.' };
    return { success: true, invitation };
  }

  function acceptTeamInvitation(invitationId) {
    const currentUser = getCurrentUser();
    if (!currentUser) return { success: false, reason: 'login', message: 'Log in to accept this invitation.' };
    const invitations = getInvitations();
    const index = invitations.findIndex((invite) => invite.invitationId === invitationId && invite.receiverId === currentUser.userId && invite.status === 'PENDING');
    if (index < 0) return { success: false, reason: 'missing', message: 'Invitation not found or already handled.' };
    const invitation = invitations[index];
    const currentTeam = getTeamById(invitation.teamId);
    const beforeTeams = getTeams();
    const added = appendMember(invitation.teamId, currentUser);
    if (!added.success) return added;
    const updatedInvitations = invitations.map((invite, inviteIndex) => inviteIndex === index ? { ...invite, status: 'ACCEPTED' } : invite);
    if (!saveInvitations(updatedInvitations)) {
      saveTeams(beforeTeams);
      globalThis.ArenaAuth.updateUser(currentUser.userId, { teamId: null });
      return { success: false, reason: 'storage', message: 'Your browser could not save this invitation response.' };
    }
    return { success: true, team: added.team, invitation: updatedInvitations[index], priorTeam: currentTeam };
  }

  function declineTeamInvitation(invitationId) {
    const currentUser = getCurrentUser();
    if (!currentUser) return { success: false, reason: 'login', message: 'Log in to decline this invitation.' };
    const invitations = getInvitations();
    const index = invitations.findIndex((invite) => invite.invitationId === invitationId && invite.receiverId === currentUser.userId && invite.status === 'PENDING');
    if (index < 0) return { success: false, reason: 'missing', message: 'Invitation not found or already handled.' };
    const updatedInvitations = invitations.map((invite, inviteIndex) => inviteIndex === index ? { ...invite, status: 'DECLINED' } : invite);
    if (!saveInvitations(updatedInvitations)) return { success: false, reason: 'storage', message: 'Your browser could not save this invitation response.' };
    return { success: true, invitation: updatedInvitations[index] };
  }

  function getTeamTournamentRegistrations(teamId) {
    return (globalThis.ArenaTournaments?.getParticipants?.() || []).filter((registration) => registration.teamId === teamId);
  }

  globalThis.ArenaTeams = Object.freeze({
    getTeams,
    saveTeams,
    getTeamById,
    getUserTeam,
    getTeamStats,
    createTeam,
    updateTeam,
    addTeamMember,
    removeTeamMember,
    leaveTeam,
    transferCaptain,
    getTeamInvitations,
    getUserInvitations,
    sendTeamInvitation,
    acceptTeamInvitation,
    declineTeamInvitation,
    getTeamTournamentRegistrations
  });
})();
