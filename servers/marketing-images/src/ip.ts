import { isIP } from 'node:net';

/**
 * IP classification for the SSRF guard: which addresses may a user-supplied URL point at?
 * IPv4 uses a deny-list of every non-global range; IPv6 uses an allow-list (global unicast
 * 2000::/3 minus documentation/transition/protocol blocks), which is safer than enumerating bad ranges.
 */

function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Expand an IPv6 literal to eight 16-bit groups, or null if malformed. Zone ids (`%eth0`) are rejected. */
export function parseIPv6(text: string): number[] | null {
  if (text.includes('%')) return null;
  let head = text;
  let v4Tail: number[] | null = null;
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    v4Tail = parseIPv4(text.slice(lastColon + 1));
    if (!v4Tail) return null;
    head = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groups: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const left = toGroups(halves[0] as string);
  if (!left) return null;
  let groups: number[];
  if (halves.length === 2) {
    const right = toGroups(halves[1] as string);
    if (!right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  if (v4Tail) {
    groups[6] = ((v4Tail[0] as number) << 8) | (v4Tail[1] as number);
    groups[7] = ((v4Tail[2] as number) << 8) | (v4Tail[3] as number);
  }
  return groups;
}

function ipv4Blocked(o: readonly number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier-grade NAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24 protocol, 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function ipv6Blocked(g: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const v4 = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];

  // IPv4-mapped ::ffff:a.b.c.d and the deprecated IPv4-compatible ::a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return ipv4Blocked(v4(g6, g7));
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true; // ::, ::1, ::a.b.c.d
  // NAT64 64:ff9b::/96 embeds an IPv4 address; 64:ff9b:1::/48 is local-use.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4Blocked(v4(g6, g7));

  if ((g0 & 0xe000) !== 0x2000) return true; // only global unicast 2000::/3 is allowed
  if (g0 === 0x2001 && g1 < 0x0200) return true; // 2001::/23 protocol assignments (Teredo, ORCHID, ...)
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2002) return true; // 6to4
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true; // 3fff::/20 documentation
  return false;
}

/** True when `address` (an IPv4 or IPv6 literal, no brackets) must not be fetched. Unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIPv4(address);
    return octets ? ipv4Blocked(octets) : true;
  }
  if (family === 6) {
    const groups = parseIPv6(address);
    return groups ? ipv6Blocked(groups) : true;
  }
  return true;
}

export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return parseIPv4(address)?.[0] === 127;
  if (family === 6) {
    const g = parseIPv6(address);
    if (!g) return false;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return (g[6] as number) >> 8 === 127;
  }
  return false;
}
