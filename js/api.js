(() => {
  const API_BASE_URL = '';

  class ApiError extends Error {
    constructor(code, message, status = 0) {
      super(message);
      this.name = 'ArenaApiError';
      this.code = code;
      this.status = status;
    }
  }

  function requestUrl(path) {
    const normalizedPath = String(path).replace(/^\/+/, '');
    if (!API_BASE_URL) return new URL(normalizedPath, document.baseURI).href;
    const baseUrl = new URL(API_BASE_URL, document.baseURI);
    if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
    return new URL(normalizedPath, baseUrl).href;
  }

  function errorForStatus(status, path, payload = null) {
    const backendCode = payload?.error?.code;
    const competitionMessages = {
      TOURNAMENT_FULL: 'This tournament is full.',
      REGISTRATION_CLOSED: 'Registration is closed for this tournament.',
      DUPLICATE_REGISTRATION: 'You or a player on your team is already registered.',
      TEAM_REQUIRED: 'A team is required for this tournament type.',
      WRONG_ROSTER_SIZE: 'The current team roster does not match this tournament type.',
      TEAM_MEMBERSHIP_REQUIRED: 'You must be a member of the selected team to register it.',
      ALREADY_IN_TEAM: 'That player already belongs to a team.',
      CAPTAIN_TRANSFER_REQUIRED: 'Transfer captaincy before removing the captain.',
      ROSTER_LOCKED: 'This roster cannot change while its tournament registration is active.',
      INVITATION_HANDLED: 'This invitation has already been handled.',
      MATCH_CAPACITY_EXCEEDED: 'Selected registrations exceed match capacity.',
      MATCH_CAPACITY_BELOW_PARTICIPANTS: 'Match capacity cannot be lower than its selected registrations.',
      INVALID_PARTICIPANTS: 'One or more selected registrations are invalid.',
      INVALID_RESULT_PARTICIPANT: 'The selected result participant is not registered for this match.',
      ROOM_ENCRYPTION_UNAVAILABLE: 'Room credentials cannot be saved until secure backend storage is configured.'
    };
    if (competitionMessages[backendCode]) return new ApiError(backendCode, competitionMessages[backendCode], status);
    if (status === 400 || status === 422) return new ApiError('VALIDATION', 'Check the details and try again.', status);
    if (status === 401) {
      const message = path === '/api/auth/login'
        ? 'Email/username or password was not recognized.'
        : 'Your session is missing or expired. Log in and try again.';
      return new ApiError('UNAUTHORIZED', message, status);
    }
    if (status === 403) return new ApiError('FORBIDDEN', 'You are not allowed to perform this action.', status);
    if (status === 404) return new ApiError('NOT_FOUND', 'The requested competition record was not found or is no longer available.', status);
    if (status === 409) {
      const message = path === '/api/auth/register'
        ? 'An account with those details already exists.'
        : 'This change conflicts with the current competition data. Refresh and try again.';
      return new ApiError('CONFLICT', message, status);
    }
    if (status === 429) return new ApiError('RATE_LIMITED', 'Too many attempts. Please wait and try again.', status);
    return new ApiError('BACKEND_UNAVAILABLE', 'The backend is unavailable. Please try again later.', status);
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    const requestOptions = { ...options, headers, credentials: 'include', cache: 'no-store' };
    if (options.body !== undefined && typeof options.body !== 'string') {
      headers.set('Content-Type', 'application/json');
      requestOptions.body = JSON.stringify(options.body);
    }

    let response;
    try {
      response = await fetch(requestUrl(path), requestOptions);
    } catch {
      throw new ApiError('NETWORK', 'Could not reach the authentication service. Check your connection or backend configuration.');
    }

    let payload = null;
    let parseFailed = false;
    try {
      const text = await response.text();
      if (text) payload = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
    if (!response.ok) {
      if (parseFailed || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ApiError('BACKEND_UNAVAILABLE', 'The backend is unavailable or returned an unexpected response.', response.status);
      }
      throw errorForStatus(response.status, path, payload);
    }
    if (parseFailed) throw new ApiError('BACKEND_UNAVAILABLE', 'The backend returned an unexpected response.', response.status);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ApiError('BACKEND_UNAVAILABLE', 'The backend returned an unexpected response.', response.status);
    }
    return payload;
  }

  globalThis.ArenaApi = Object.freeze({ ApiError, request });
})();