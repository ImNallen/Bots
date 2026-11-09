// Which addresses a free tool may connect to. The network rules (infra/proxmox/bots-guard.nft on a VM,
// apps/computerd/netguard/netguard.sh in Docker) refuse private and LAN addresses for the whole computer, but they leave loopback
// open and they allow the orchestrator's link. Chromium's CDP and the VNC streams answer a plain HTTP GET on loopback, so a tool that
// needs no approval and that a page can point anywhere must refuse every address that is not public.
import { BlockList, isIP } from "node:net";

// Every IPv4 range that is not globally routable unicast, from the IANA special-purpose registry. 255.255.255.255 is in 240/4.
// addresses.test.ts fails if bots-guard.nft or netguard.sh lists a range that this list does not refuse.
const NOT_PUBLIC_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

// IPv6 is an allow list of global unicast, 2000::/3, which alone refuses ::, ::1, v4-mapped, NAT64, fc00::/7, fe80::/10, and
// multicast. These are the parts of 2000::/3 that are not public or that carry an IPv4 address inside: IETF assignments with Teredo
// (2001::/23), documentation (2001:db8::/32 and 3fff::/20), and 6to4 (2002::/16).
const GLOBAL_UNICAST_V6 = "2000::/3";
const NOT_PUBLIC_V6 = ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"] as const;

function blockListOf(ranges: readonly string[], type: "ipv4" | "ipv6"): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    const [network = "", prefix = ""] = range.split("/");
    list.addSubnet(network, Number(prefix), type);
  }
  return list;
}

const notPublicV4 = blockListOf(NOT_PUBLIC_V4, "ipv4");
const globalV6 = blockListOf([GLOBAL_UNICAST_V6], "ipv6");
const notPublicV6 = blockListOf(NOT_PUBLIC_V6, "ipv6");

/** True only for a globally routable unicast address. Anything that is not a plain IP address, such as one with a zone id, is false. */
export function isPublicIp(ip: string): boolean {
  if (ip.includes("%")) {
    return false;
  }
  switch (isIP(ip)) {
    case 4:
      return !notPublicV4.check(ip, "ipv4");
    case 6:
      return globalV6.check(ip, "ipv6") && !notPublicV6.check(ip, "ipv6");
    default:
      return false;
  }
}

declare const checked: unique symbol;

/**
 * An address that isPublicIp accepted. Only publicAddressFor makes one, and Network.open in web.ts takes nothing else, so a
 * connection to an address that skipped the check does not compile. web.ts connects to exactly this address and never resolves the
 * name again, which makes a name that changes its answer between two lookups harmless.
 */
export type PublicAddress = { readonly ip: string; readonly family: 4 | 6; readonly [checked]: true };

/** Every address a name resolves to. In production this is dns.lookup with all: true, which reads /etc/hosts like any program. */
export type Resolve = (hostname: string) => Promise<readonly { address: string }[]>;

export type AddressCheck = { kind: "public"; address: PublicAddress } | { kind: "refused"; reason: string };

/**
 * Takes URL.hostname, so an IPv6 literal arrives in brackets and an IPv4 literal arrives normalized by the URL parser
 * (http://2130706433/ and http://0x7f.1/ are both 127.0.0.1 by then). An IP literal is checked as it is and never resolved. A name
 * is resolved once, and if any answer is not public the whole name is refused, because a public site has no private answers. Of the
 * rest, the first IPv4 answer wins, because a VM on Proxmox has no IPv6 route out. A failed lookup rejects with the resolver's error.
 */
export async function publicAddressFor(hostname: string, resolve: Resolve): Promise<AddressCheck> {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const literal = isIP(bare);
  const answers = literal === 0 ? await resolve(bare) : [{ address: bare }];
  const blocked = answers.find((answer) => !isPublicIp(answer.address));
  if (blocked !== undefined) {
    const where = literal === 0 ? `${bare} is at ${blocked.address}, which is not one` : `${bare} is not one`;
    return { kind: "refused", reason: `Only public internet addresses can be opened, and ${where}.` };
  }
  const chosen = answers.find((answer) => isIP(answer.address) === 4) ?? answers[0];
  if (chosen === undefined) {
    return { kind: "refused", reason: `${bare} has no address.` };
  }
  return { kind: "public", address: { ip: chosen.address, family: isIP(chosen.address) === 6 ? 6 : 4 } as PublicAddress };
}
