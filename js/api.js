(() => {
  class ApiError extends Error {
    constructor(code, message, status = 0) {
      super(message);
      this.name = 'ArenaApiError';
      this.code = code;
      this.status = status;
    }
  }

  function configuredBaseUrl() {
    const configured = globalThis.ARENA_API_BASE_URL
      || document.querySelector?.('meta[name="arena-api-base-url"]')?.content
      || '';
    if (configured) return String(configured).trim();
    const pageUrl = new URL(document.baseURI);
    if (pageUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(pageUrl.hostname)) {
      return `${pageUrl.protocol}//${pageUrl.hostname}:3000`;
    }
    return '';
  }

  const API_BASE_URL = configuredBaseUrl();

  function requestUrl(path) {
    const normalizedPath = String(path).replace(/^\/+/, '');
    if (!API_BASE_URL) return new URL(normalizedPath, document.baseURI).href;
    let baseUrl;
    try {
      baseUrl = new URL(API_BASE_URL, document.baseURI);
    } catch {
      throw new ApiError('CONFIGURATION', 'The backend API URL is invalid. Check the frontend API configuration.');
    }
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
    if (!['http:', 'https:'].includes(baseUrl.protocol)
      || baseUrl.username || baseUrl.password
      || (baseUrl.protocol !== 'https:' && !localHost)) {
      throw new ApiError('CONFIGURATION', 'The backend API URL must use HTTPS, except for local development.');
    }
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
      ROOM_ENCRYPTION_UNAVAILABLE: 'Room credentials cannot be saved until secure backend storage is configured.',
      INSUFFICIENT_FUNDS: 'Available wallet balance is insufficient.',
      INVALID_AMOUNT: 'Enter a valid positive amount in rupees.',
      INVALID_IDEMPOTENCY_KEY: 'The withdrawal request could not be identified safely. Please try again.',
      IDEMPOTENCY_KEY_REUSED: 'This withdrawal request conflicts with an earlier request. Refresh wallet history and try again.',
      DUPLICATE_TRANSACTION: 'This wallet transaction has already been processed.'
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
    if (status === 404) {
      const message = path.startsWith('/api/auth/') || path === '/api/users/me' || path === '/api/users/me/close'
        ? 'The authentication service endpoint is unavailable. Check the backend URL.'
        : 'The requested competition record was not found or is no longer available.';
      return new ApiError('NOT_FOUND', message, status);
    }
    if (status === 409) {
      const message = path === '/api/auth/register'
        ? 'An account with those details already exists.'
        : path === '/api/users/me/close'
          ? 'Your account could not be closed. Refresh and try again.'
        : backendCode === 'INSUFFICIENT_FUNDS'
          ? 'Available wallet balance is insufficient.'
          : backendCode === 'IDEMPOTENCY_KEY_REUSED' || backendCode === 'DUPLICATE_TRANSACTION'
            ? 'This withdrawal request conflicts with an earlier request. Refresh wallet history and try again.'
        : 'This change conflicts with the current competition data. Refresh and try again.';
      return new ApiError('CONFLICT', message, status);
    }
    if (status === 429) return new ApiError('RATE_LIMITED', 'Too many attempts. Please wait and try again.', status);
    if (status >= 500) return new ApiError('BACKEND_UNAVAILABLE', 'The backend is unavailable. Please try again later.', status);
    return new ApiError('REQUEST_FAILED', 'The request could not be completed. Please try again.', status);
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    const requestOptions = { ...options, headers, credentials: 'include', cache: 'no-store' };
    if (options.body !== undefined && typeof options.body !== 'string') {
      headers.set('Content-Type', 'application/json');
      requestOptions.body = JSON.stringify(options.body);
    }

    const url = requestUrl(path);
    let response;
    try {
      response = await fetch(url, requestOptions);
    } catch {
      throw new ApiError('NETWORK', 'Could not reach the backend. Check your connection or backend configuration.');
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

  globalThis.ArenaApi = Object.freeze({ ApiError, request, baseUrl: API_BASE_URL });
})();