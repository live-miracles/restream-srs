import net from 'net';

const MAX_WHITELIST_IPS = 50;

// Accepts a bare IPv4/IPv6 address or CIDR (e.g. "203.0.113.4" or
// "203.0.113.0/24") — the same shapes fail2ban's `ignoreip` directive accepts.
export function isValidIpOrCidr(value: string): boolean {
    const slash = value.indexOf('/');
    const addr = slash === -1 ? value : value.slice(0, slash);
    const version = net.isIP(addr);
    if (version === 0) return false;
    if (slash === -1) return true;

    const maskText = value.slice(slash + 1);
    if (!/^\d+$/.test(maskText)) return false;
    const mask = Number(maskText);
    return version === 4 ? mask >= 0 && mask <= 32 : mask >= 0 && mask <= 128;
}

// Trims/dedupes/validates a submitted whitelist. Returns null if anything in
// the list doesn't parse as an IP/CIDR or the list is too long.
export function normalizeIpWhitelist(value: unknown): string[] | null {
    if (!Array.isArray(value)) return [];

    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'string') return null;
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (!isValidIpOrCidr(trimmed)) return null;
        seen.add(trimmed);
    }
    if (seen.size > MAX_WHITELIST_IPS) return null;
    return [...seen];
}
