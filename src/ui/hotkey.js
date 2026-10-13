// Keyboard shortcuts that work in every program, not only while Weave is in front.
//
// A shortcut someone presses mid-game reaches Weave only if the operating system hands it
// over, and the desktop shell asks for that with Electron's global shortcuts. The price is
// that the key is TAKEN: while it is registered, no other program receives it. So a bare
// letter can never be one — binding "M" would stop the person typing an M anywhere on the
// machine — and neither can Shift with a letter, which is just a capital. A shortcut has to
// carry Ctrl, Alt or the Windows key, or be a function key that nothing types with.
//
// A binding is stored as one string, the held modifiers in a fixed order and then the
// physical key's `event.code`: `Control+Shift+KeyM`, `F9`. The code rather than the key for
// the same reason push-to-talk uses it — a bind made on one keyboard layout keeps working on
// another. Everything here is pure, so what a press becomes is tested rather than hoped.

/** The modifiers, in the order a binding names them, and the event flag behind each. */
const MODIFIERS = [
    ['Control', 'ctrlKey'],
    ['Alt', 'altKey'],
    ['Shift', 'shiftKey'],
    ['Meta', 'metaKey'],
];
const MODIFIER_NAMES = new Set(MODIFIERS.map(([name]) => name));

/** Keys that are only ever a modifier. Pressing one on its own means "keep going". */
const MODIFIER_CODES = new Set([
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight',
    'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
]);

/** Electron's name for each modifier. Its Windows key is called Super. */
const ACCELERATOR_MODIFIER = { Control: 'Control', Alt: 'Alt', Shift: 'Shift', Meta: 'Super' };
const LABEL_MODIFIER = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

/**
 * `event.code` values with a name of their own in Electron's accelerator grammar.
 *
 * Letters, digits, function keys and the number pad are worked out by pattern below; this
 * is everything else that grammar can express. A code missing here cannot be registered,
 * and is refused when it is pressed rather than accepted and then silently never working.
 */
const NAMED_KEYS = {
    Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Enter: 'Return', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
    PrintScreen: 'PrintScreen', ScrollLock: 'Scrolllock',
    MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack',
    MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop',
    AudioVolumeMute: 'VolumeMute', AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown',
};

/** What a person reads for the keys whose accelerator name is not what is printed on them. */
const LABEL_KEYS = {
    Return: 'Enter', Up: '↑', Down: '↓', Left: '←', Right: '→',
    numadd: 'Num +', numsub: 'Num -', nummult: 'Num *', numdiv: 'Num /', numdec: 'Num .',
    Scrolllock: 'Scroll Lock', MediaPlayPause: 'Play/Pause', MediaNextTrack: 'Next track',
    MediaPreviousTrack: 'Previous track', MediaStop: 'Stop', VolumeMute: 'Mute',
    VolumeUp: 'Volume up', VolumeDown: 'Volume down', PageUp: 'Page Up', PageDown: 'Page Down',
    PrintScreen: 'Print Screen',
};

const isFunctionKey = (code) => /^F([1-9]|1[0-9]|2[0-4])$/.test(code);

/** The accelerator name for one physical key, or null if Electron has no way to say it. */
function keyName(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (isFunctionKey(code)) return code;
    if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
    return NAMED_KEYS[code] ?? null;
}

/** Split a stored binding back into its parts, or null if it is not one. */
function parse(binding) {
    if (typeof binding !== 'string' || !binding) return null;
    const parts = binding.split('+');
    const code = parts.pop();
    if (!code || !keyName(code)) return null;
    if (!parts.every((m) => MODIFIER_NAMES.has(m))) return null;
    return { mods: new Set(parts), code };
}

/** Whether a binding may be taken from every other program. See the header. */
function safeEverywhere(mods, code) {
    return mods.has('Control') || mods.has('Alt') || mods.has('Meta') || isFunctionKey(code);
}

/**
 * What one keydown becomes while a shortcut is being chosen.
 *
 * @returns {{binding: string}|{pending: true}|{error: 'needs-modifier'|'unsupported'}}
 *   `pending` while only modifiers are down — the person is part-way through a combination.
 */
export function bindingFromKeydown(event) {
    const code = event?.code ?? '';
    if (!code || MODIFIER_CODES.has(code)) return { pending: true };
    if (!keyName(code)) return { error: 'unsupported' };
    const held = MODIFIERS.filter(([, flag]) => event[flag]).map(([name]) => name);
    if (!safeEverywhere(new Set(held), code)) return { error: 'needs-modifier' };
    return { binding: [...held, code].join('+') };
}

/** The sentence for a refused press, for whoever is showing the capture button. */
export function bindingError(error) {
    if (error === 'needs-modifier') return 'Add Ctrl or Alt, or use an F-key';
    if (error === 'unsupported') return 'That key cannot be a shortcut';
    return 'Try a different key';
}

/** The binding in Electron's accelerator grammar, e.g. `Control+Shift+M`, or null. */
export function acceleratorFor(binding) {
    const parsed = parse(binding);
    if (!parsed) return null;
    const mods = MODIFIERS.map(([name]) => name).filter((m) => parsed.mods.has(m));
    return [...mods.map((m) => ACCELERATOR_MODIFIER[m]), keyName(parsed.code)].join('+');
}

/** The binding as a person reads it, e.g. `Ctrl + Shift + M`. */
export function labelFor(binding) {
    const parsed = parse(binding);
    if (!parsed) return 'Not set';
    const key = keyName(parsed.code);
    const keyLabel = LABEL_KEYS[key] ?? (/^num[0-9]$/.test(key) ? `Num ${key.slice(3)}` : key);
    const mods = MODIFIERS.map(([name]) => name).filter((m) => parsed.mods.has(m));
    return [...mods.map((m) => LABEL_MODIFIER[m]), keyLabel].join(' + ');
}

/**
 * Whether a keydown IS this binding, for the browser build where no global shortcut exists.
 *
 * Exact on modifiers: Ctrl+Shift+M must not also fire on Ctrl+Alt+Shift+M, which is very
 * likely somebody else's shortcut.
 */
export function matchesKeydown(event, binding) {
    const parsed = parse(binding);
    if (!parsed || event?.code !== parsed.code) return false;
    return MODIFIERS.every(([name, flag]) => Boolean(event[flag]) === parsed.mods.has(name));
}
