// Secret scrubbing for text that originates from FFmpeg/FFprobe stderr. At
// -loglevel warning FFmpeg still echoes full URLs on failure ("Error opening
// output rtmp://host/live2/<key>", "...srt://...&passphrase=<secret>"), and
// those tails end up in SQLite, the diagnostics files, journald and the
// dashboard. Everything here keeps the non-secret parts (scheme, host, port,
// app name) because they are what an incident investigation needs.

const URL_RE = /\b(?:rtmps?|srt):\/\/[^\s'"<>]+/gi;
const TRAILING_PUNCT_RE = /[:.,;)\]]+$/;
const SECRET_QUERY_KEYS = new Set(['passphrase', 'streamid']);
const MIN_TOKEN_LENGTH = 6;
const REDACTED = '<redacted>';

function redactQuery(query: string): string {
    return query
        .split('&')
        .map((pair) => {
            const eq = pair.indexOf('=');
            if (eq < 0) return pair;
            return SECRET_QUERY_KEYS.has(pair.slice(0, eq).toLowerCase())
                ? `${pair.slice(0, eq)}=${REDACTED}`
                : pair;
        })
        .join('&');
}

// Scheme/host/port are kept. RTMP(S): the first path segment (the app) is kept,
// everything after it (the stream key and any query) is dropped. SRT: only the
// passphrase and streamid values are dropped. Userinfo is always dropped.
export function redactUrl(url: string): string {
    const match = /^([a-z]+):\/\/([^/?#]*)(.*)$/is.exec(url);
    if (!match) return url;
    const [, scheme, authority, rest] = match;
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    if (scheme.toLowerCase() === 'srt') {
        const q = rest.indexOf('?');
        return q < 0
            ? `srt://${host}${rest}`
            : `srt://${host}${rest.slice(0, q + 1)}${redactQuery(rest.slice(q + 1))}`;
    }
    const path = rest.replace(/[?#].*$/s, '');
    const segments = path.split('/').filter(Boolean);
    const hadSecret = segments.length > 1 || rest.length > path.length;
    const app = segments[0] ? `/${segments[0]}` : '';
    return `${scheme}://${host}${app}${hadSecret ? `/${REDACTED}` : ''}`;
}

// Standalone secret values worth scrubbing even outside a URL: a destination's
// stream key (last path segment), and passphrase/streamid query values.
export function secretTokensFromUrl(url: string): string[] {
    const tokens: string[] = [];
    const match = /^[a-z]+:\/\/[^/?#]*([^?#]*)\??([^#]*)/is.exec(url);
    if (!match) return tokens;
    const last = match[1].split('/').filter(Boolean).slice(1).pop();
    if (last) tokens.push(last);
    for (const pair of match[2].split('&')) {
        const eq = pair.indexOf('=');
        if (eq > 0 && SECRET_QUERY_KEYS.has(pair.slice(0, eq).toLowerCase())) {
            tokens.push(pair.slice(eq + 1));
        }
    }
    return tokens;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(text: string, tokens: readonly string[] = []): string {
    let out = text.replace(URL_RE, (m) => {
        const trailing = TRAILING_PUNCT_RE.exec(m)?.[0] ?? '';
        return redactUrl(trailing ? m.slice(0, -trailing.length) : m) + trailing;
    });
    out = out
        .replace(/passphrase=[^&\s]*/gi, `passphrase=${REDACTED}`)
        .replace(/\bkey\d+_[0-9a-f]+/gi, (m) => `${m.slice(0, m.indexOf('_') + 1)}${REDACTED}`);
    for (const token of tokens) {
        if (token.length >= MIN_TOKEN_LENGTH) {
            out = out.replace(new RegExp(escapeRegExp(token), 'g'), REDACTED);
        }
    }
    return out;
}
