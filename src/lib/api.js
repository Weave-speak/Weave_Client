// Talking to a Weave server.
//
// Every request goes through here so that the server's base URL is supplied in exactly one
// place. The old client had two dozen root-relative fetch literals, which worked only
// because the page was always served by the server it talked to — the assumption that had
// to be unpicked to make a native client possible at all.

export class ApiError extends Error {
    constructor(message, { status, field, detail } = {}) {
        super(message);
        this.status = status;
        this.field = field;
        this.detail = detail;
    }
}

const TIMEOUT_MS = 15_000;

export function createApi({ origin, token = null }) {
    let bearer = token;

    async function request(method, path, { body, timeoutMs = TIMEOUT_MS, raw = false } = {}) {
        let response;
        try {
            response = await fetch(origin + path, {
                method,
                headers: {
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
                    Accept: 'application/json',
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
                // Bearer tokens, not cookies. The server echoes the request origin without
                // Allow-Credentials precisely so that a hostile page can make a request but
                // cannot attach anyone's session.
                credentials: 'omit',
                cache: 'no-store',
            });
        } catch (err) {
            if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
                throw new ApiError('The server took too long to respond.', { status: 0 });
            }
            throw new ApiError('Lost contact with the server.', { status: 0, detail: err?.message });
        }

        if (raw) return response;

        let data = null;
        try { data = await response.json(); } catch { /* an empty body is legitimate */ }

        if (!response.ok) {
            throw new ApiError(
                data?.message ?? `Request failed (${response.status}).`,
                { status: response.status, field: data?.detail?.field, detail: data?.detail },
            );
        }
        return data;
    }

    return {
        get origin() { return origin; },
        get token() { return bearer; },
        setToken(value) { bearer = value; },

        serverInfo: () => request('GET', '/api/server-info'),
        securityQuestions: () => request('GET', '/api/auth/questions'),

        login: (username, password) =>
            request('POST', '/api/auth/login', { body: { username, password } }),

        register: (payload) =>
            request('POST', '/api/auth/register', { body: payload }),

        /**
         * Step one of a reset. Always succeeds and always returns a question, including
         * for a username with no account — the server does that deliberately so this
         * endpoint cannot be used to discover who has an account. The client must not
         * treat "we got a question" as proof the account exists.
         */
        recoveryQuestion: (username) =>
            request('POST', '/api/auth/recovery-question', { body: { username } }),

        recover: ({ username, questionId, answer, newPassword }) =>
            request('POST', '/api/auth/recover', {
                body: { username, questionId, answer, newPassword },
            }),

        me: () => request('GET', '/api/me'),
        channels: () => request('GET', '/api/channels'),
        logout: () => request('POST', '/api/auth/logout'),

        request,
    };
}
