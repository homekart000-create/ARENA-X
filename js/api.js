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

  function errorForStatus(status) {
    if (status === 400) return new ApiError('BAD_REQUEST', 'Check the details and try again.', status);
    if (status === 401) return new ApiError('UNAUTHORIZED', 'Email/username or password was not recognized.', status);
    if (status === 403) return new ApiError('FORBIDDEN', 'This action is not allowed from this website.', status);
    if (status === 409) return new ApiError('CONFLICT', 'An account with those details already exists.', status);
    if (status === 429) return new ApiError('RATE_LIMITED', 'Too many attempts. Please wait and try again.', status);
    return new ApiError('BACKEND_UNAVAILABLE', 'Authentication service is unavailable. Please try again later.', status);
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
    try {
      const text = await response.text();
      if (text) payload = JSON.parse(text);
    } catch {
      if (response.ok) throw new ApiError('BACKEND_UNAVAILABLE', 'The authentication service returned an unexpected response.', response.status);
    }
    if (!response.ok) throw errorForStatus(response.status);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ApiError('BACKEND_UNAVAILABLE', 'The authentication service returned an unexpected response.', response.status);
    }
    return payload;
  }

  globalThis.ArenaApi = Object.freeze({ ApiError, request });
})();