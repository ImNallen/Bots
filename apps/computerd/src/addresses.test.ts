import { readFile } from "node:fs/promises";
import { isIPv6 } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { isPublicIp, publicAddressFor, type Resolve } from "./addresses.ts";

const fromRepo = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

// The first, middle, and last address of a range, which is where a guard that disagrees with it would show.
function samplesOf(range: string): string[] {
  const [network = "", prefix = ""] = range.split("/");
  const v6 = isIPv6(network);
  const bits = v6 ? 128 : 32;
  const value = v6 ? v6Value(network) : network.split(".").reduce((sum, part) => (sum << 8n) + BigInt(part), 0n);
  const size = 1n << BigInt(bits - Number(prefix));
  const first = value & ~(size - 1n);
  return [first, first + size / 2n, first + size - 1n].map((address) => (v6 ? v6Text(address) : v4Text(address)));
}

function v6Value(address: string): bigint {
  const [head = "", tail = ""] = address.split("::");
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const all = [...groups(head), ...Array<string>(8 - groups(head).length - groups(tail).length).fill("0"), ...groups(tail)];
  return all.reduce((sum, group) => (sum << 16n) + BigInt(`0x${group}`), 0n);
}

const v6Text = (value: bigint) => Array.from({ length: 8 }, (_, index) => ((value >> BigInt(112 - 16 * index)) & 0xffffn).toString(16)).join(":");
const v4Text = (value: bigint) => Array.from({ length: 4 }, (_, index) => ((value >> BigInt(24 - 8 * index)) & 0xffn).toString()).join(".");

const noResolver: Resolve = () => Promise.reject(new Error("an IP literal must not be resolved"));

describe("isPublicIp", () => {
  it.each(["8.8.8.8", "93.184.216.34", "1.1.1.1", "223.255.255.255", "2606:4700:4700::1111", "2a00:1450:4001:82a::200e"])(
    "accepts the public address %s",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );

  it.each([
    ["this network", "0.0.0.0", "0.255.255.255"],
    ["private 10/8", "10.0.0.0", "10.255.255.255"],
    ["shared address space", "100.64.0.0", "100.127.255.255"],
    ["loopback", "127.0.0.0", "127.255.255.255"],
    ["link local", "169.254.0.0", "169.254.255.255"],
    ["private 172.16/12", "172.16.0.0", "172.31.255.255"],
    ["IETF protocol assignments", "192.0.0.0", "192.0.0.255"],
    ["documentation 1", "192.0.2.0", "192.0.2.255"],
    ["the old 6to4 relay", "192.88.99.0", "192.88.99.255"],
    ["private 192.168/16", "192.168.0.0", "192.168.255.255"],
    ["benchmarking", "198.18.0.0", "198.19.255.255"],
    ["documentation 2", "198.51.100.0", "198.51.100.255"],
    ["documentation 3", "203.0.113.0", "203.0.113.255"],
    ["multicast", "224.0.0.0", "239.255.255.255"],
    ["reserved and broadcast", "240.0.0.0", "255.255.255.255"],
  ])("refuses %s at its first and last address", (_label, first, last) => {
    expect(isPublicIp(first)).toBe(false);
    expect(isPublicIp(last)).toBe(false);
  });

  it.each(["9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0"])(
    "accepts %s, just outside a range it refuses",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );

  it.each([
    ["loopback", "::1"],
    ["the unspecified address", "::"],
    ["v4-mapped loopback", "::ffff:127.0.0.1"],
    ["a v4-mapped public address", "::ffff:8.8.8.8"],
    ["NAT64", "64:ff9b::808:808"],
    ["6to4", "2002:7f00:1::"],
    ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["unique local", "fd12:3456::1"],
    ["link local", "fe80::1"],
    ["multicast", "ff02::1"],
    ["documentation", "2001:db8::1"],
    ["the newer documentation range", "3fff::1"],
    ["a zone id", "2606:4700:4700::1111%eth0"],
    ["a name", "localhost"],
    ["nothing", ""],
  ])("refuses %s", (_label, ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it("refuses every range that the VM's and Docker's network rules refuse, so the lists cannot drift apart", async () => {
    const nft = await fromRepo("infra/proxmox/bots-guard.nft");
    const set = /set not_public \{[\s\S]*?elements = \{([\s\S]*?)\}/.exec(nft)?.[1] ?? "";
    const netguard = await fromRepo("apps/computerd/netguard/netguard.sh");
    const listed = (name: string) => (new RegExp(`^${name}="(.*)"$`, "m").exec(netguard)?.[1] ?? "").split(" ");
    const nftRanges = set.split(",").map((range) => range.trim()).filter((range) => range !== "");
    const ranges = [...nftRanges, ...listed("BLOCKED_V4"), ...listed("BLOCKED_V6")];
    expect(nftRanges).toContain("127.0.0.0/8");
    expect(listed("BLOCKED_V4")).toContain("127.0.0.0/8");
    expect(listed("BLOCKED_V6")).toContain("::ffff:0:0/96");
    for (const range of ranges) {
      for (const ip of samplesOf(range)) {
        expect(isPublicIp(ip), `${ip} in ${range}`).toBe(false);
      }
    }
  });
});

describe("publicAddressFor", () => {
  it.each(["93.184.216.34", "[2606:4700:4700::1111]"])("checks the IP literal %s without resolving it", async (hostname) => {
    const check = await publicAddressFor(hostname, noResolver);
    expect(check).toMatchObject({ kind: "public", address: { ip: hostname.replace(/^\[|\]$/g, "") } });
  });

  it.each([
    ["127.0.0.1", "127.0.0.1 is not one"],
    ["[::1]", "::1 is not one"],
    ["10.78.0.2", "10.78.0.2 is not one"],
  ])("refuses the literal %s without resolving it", async (hostname, reason) => {
    expect(await publicAddressFor(hostname, noResolver)).toEqual({ kind: "refused", reason: expect.stringContaining(reason) });
  });

  it("refuses a name when any of its answers is not public, and names that answer", async () => {
    const resolve = vi.fn<Resolve>(async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]);
    expect(await publicAddressFor("mixed.example", resolve)).toEqual({
      kind: "refused",
      reason: "Only public internet addresses can be opened, and mixed.example is at 127.0.0.1, which is not one.",
    });
    expect(resolve).toHaveBeenCalledWith("mixed.example");
  });

  it("prefers the first IPv4 answer", async () => {
    const resolve: Resolve = async () => [{ address: "2606:4700:4700::1111" }, { address: "1.1.1.1" }, { address: "1.0.0.1" }];
    expect(await publicAddressFor("one.example", resolve)).toMatchObject({ kind: "public", address: { ip: "1.1.1.1", family: 4 } });
  });

  it("takes an IPv6 answer when there is no IPv4 one", async () => {
    const resolve: Resolve = async () => [{ address: "2606:4700:4700::1111" }];
    expect(await publicAddressFor("six.example", resolve)).toMatchObject({ kind: "public", address: { ip: "2606:4700:4700::1111", family: 6 } });
  });

  it("says when a name has no address", async () => {
    expect(await publicAddressFor("empty.example", async () => [])).toEqual({ kind: "refused", reason: "empty.example has no address." });
  });

  it("passes a failed lookup on to its caller", async () => {
    const failure = Object.assign(new Error("getaddrinfo ENOTFOUND gone.example"), { code: "ENOTFOUND" });
    await expect(publicAddressFor("gone.example", () => Promise.reject(failure))).rejects.toBe(failure);
  });
});
