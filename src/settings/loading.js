// What the settings dialog asks for when it opens, and how long it waits for the answers.
//
// It used to ask for each thing in turn and show nothing until the last one answered: seven
// round trips end to end, each allowed fifteen seconds, before a single pixel moved. On a
// good connection that was a second of a dead button; on a poor one it was long enough that
// people clicked again — and the second click is what broke the dialog for good (see
// modal.js). Everything here is asked for at once, and the dialog waits only briefly.
//
// Kept apart from index.js, and free of the DOM, so the timing can be tested on its own.

/**
 * How long the dialog waits for its answers before opening anyway.
 *
 * Long enough that on a healthy connection everything has arrived and the dialog appears
 * complete — a screen that draws itself empty and then fills in is one people click on
 * before it is telling the truth. Short enough that a click never feels unanswered.
 */
export const OPEN_GRACE_MS = 200;

/** Which panel each answer belongs to, so a late one repaints only where it shows. */
export const LOAD_PANELS = Object.freeze({
    me: 'profile',
    soundLibrary: 'profile',
    mySounds: 'profile',
    afk: 'voice',
    sessions: 'sessions',
    questions: 'security',
    myQuestion: 'security',
    appLog: 'bug',
});

/** A call that throws before it returns a promise is still just a failed load. */
function attempt(fn) {
    try {
        return Promise.resolve(fn());
    } catch (err) {
        return Promise.reject(err);
    }
}

/**
 * Start every load the dialog needs, all at once.
 *
 * Only what this server can answer: a feature it does not advertise is never asked about,
 * so an older server is not sent requests it can only 404.
 *
 * @returns {Record<string, Promise>} one promise per load, keyed as in LOAD_PANELS
 */
export function startLoads({ api, features = [], diagnostics = null }) {
    const has = (feature) => features.includes(feature);
    const loads = { me: attempt(() => api.me()) };

    if (has('module.afk')) loads.afk = attempt(() => api.request('GET', '/api/afk/opt-out'));
    if (has('module.sounds')) {
        loads.soundLibrary = attempt(() => api.request('GET', '/api/sounds'));
        loads.mySounds = attempt(() => api.request('GET', '/api/sounds/me'));
    }
    if (has('account.sessions')) loads.sessions = attempt(() => api.request('GET', '/api/me/sessions'));
    if (has('account.security')) {
        loads.questions = attempt(() => api.securityQuestions());
        loads.myQuestion = attempt(() => api.request('GET', '/api/me/security-question'));
    }
    // A local read, and a small one — but it used to sit in the queue with the rest.
    if (diagnostics?.available && diagnostics.readAppLog) {
        loads.appLog = attempt(() => diagnostics.readAppLog());
    }
    return loads;
}

/**
 * Wait for every load, or for `ms`, whichever comes first.
 *
 * Never rejects: a failed load is an answer like any other, and each caller already has
 * its own fallback for one.
 *
 * @returns {Promise<{ timedOut: boolean, pending: string[] }>}
 */
export function settleWithin(loads, ms) {
    const names = Object.keys(loads);
    const settled = new Set();
    const all = Promise.all(names.map((name) => loads[name].then(
        () => settled.add(name),
        () => settled.add(name),
    )));

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve({ timedOut: true, pending: names.filter((name) => !settled.has(name)) });
        }, ms);
        all.then(() => {
            clearTimeout(timer);
            resolve({ timedOut: false, pending: [] });
        });
    });
}

/**
 * Make concurrent calls share one run.
 *
 * A second call while the first is still going gets the same promise rather than starting
 * a second run alongside it; once it settles, the next call runs afresh.
 */
export function singleFlight(fn) {
    let inFlight = null;
    return (...args) => {
        if (inFlight) return inFlight;
        inFlight = attempt(() => fn(...args)).finally(() => { inFlight = null; });
        return inFlight;
    };
}
