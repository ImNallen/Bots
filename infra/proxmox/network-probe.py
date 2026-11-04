#!/usr/bin/env python3
# Runs inside a user VM as root, with no packages beyond Python. Prints one JSON object per check.
#
# A blocked packet must fail with an ICMP rejection or a timeout. "refused" means the packet reached a machine
# that answered, so it counts as reached even though nothing was listening.
import argparse
import asyncio
import contextlib
import errno
import json
import os
import resource
import socket
import ssl
import struct
import subprocess
import time
import urllib.error
import urllib.request

BLOCKED_ERRNOS = {errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EACCES, errno.EPERM, errno.EADDRNOTAVAIL}
SCAN_CONCURRENCY = 512
TCP_TIMEOUT = 2.0
SCAN_TIMEOUT = 1.0
REPLY_TIMEOUT = 1.0
SAMPLE_PORTS = [22, 53, 80, 443, 3128, 5355, 8006, 8443, 8787, 8788, 3210, 3211, 6790, 6791]
SAMPLE_UDP_PORTS = [53, 123, 5353, 5355, 41641]
RESERVED_V4 = {
    "this-network": "0.0.0.1",
    "rfc1918-10": "10.0.0.1",
    "rfc1918-172": "172.16.0.1",
    "docker-on-control": "172.18.0.1",
    "rfc1918-192": "192.168.0.1",
    "tailnet-cgnat": "100.64.0.1",
    "tailscale-dns": "100.100.100.100",
    "cloud-metadata": "169.254.169.254",
    "ietf-192-0-0": "192.0.0.1",
    "test-net-1": "192.0.2.1",
    "benchmark": "198.18.0.1",
    "test-net-2": "198.51.100.1",
    "test-net-3": "203.0.113.1",
    "multicast": "224.0.0.1",
    "reserved-240": "240.0.0.1",
}

results = []


def report(check, ok, detail=""):
    row = {"check": check, "ok": bool(ok), "detail": str(detail)}
    results.append(row)
    print(json.dumps(row), flush=True)


def run(*command):
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout


async def tcp(address, port, timeout=TCP_TIMEOUT, source=None):
    local = (source, 0) if source else None
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(address, port, local_addr=local), timeout)
    except ConnectionRefusedError:
        return "refused"
    except (asyncio.TimeoutError, TimeoutError):
        return "blocked"
    except OSError as error:
        return "blocked" if error.errno in BLOCKED_ERRNOS else f"errno {error.errno}"
    writer.close()
    with contextlib.suppress(Exception):
        await writer.wait_closed()
    return "open"


async def scan(address, ports, allowed=()):
    limit = asyncio.Semaphore(SCAN_CONCURRENCY)

    async def one(port):
        async with limit:
            return port, await tcp(address, port, SCAN_TIMEOUT)

    outcomes = await asyncio.gather(*(one(port) for port in ports if port not in allowed))
    return [f"{port}={state}" for port, state in outcomes if state != "blocked"]


def dns_query(name="example.com"):
    question = b"".join(bytes([len(part)]) + part.encode() for part in name.split(".")) + b"\0"
    return struct.pack("!6H", 0x4242, 0x0100, 1, 0, 0, 0) + question + struct.pack("!2H", 1, 1)


def udp(address, port):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(REPLY_TIMEOUT)
        try:
            sock.connect((address, port))
            sock.send(dns_query())
            sock.recv(512)
        except ConnectionRefusedError:
            return "refused"
        except TimeoutError:
            return "blocked"
        except OSError as error:
            return "blocked" if error.errno in BLOCKED_ERRNOS else f"errno {error.errno}"
    return "open"


def checksum(data):
    if len(data) % 2:
        data += b"\0"
    total = sum(struct.unpack(f"!{len(data) // 2}H", data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return ~total & 0xFFFF


def ping(address):
    identifier = os.getpid() & 0xFFFF
    body = b"bots-network-probe"
    header = struct.pack("!BBHHH", 8, 0, 0, identifier, 1)
    packet = struct.pack("!BBHHH", 8, 0, checksum(header + body), identifier, 1) + body
    with socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP) as sock:
        sock.settimeout(REPLY_TIMEOUT)
        try:
            sock.sendto(packet, (address, 0))
        except OSError:
            return False
        deadline = time.monotonic() + REPLY_TIMEOUT
        while time.monotonic() < deadline:
            try:
                data, peer = sock.recvfrom(1024)
            except TimeoutError:
                return False
            offset = (data[0] & 0x0F) * 4
            kind, _, _, reply_id = struct.unpack("!BBHH", data[offset:offset + 6])
            if kind == 0 and reply_id == identifier and peer[0] == address:
                return True
    return False


def default_interface():
    return run("ip", "-json", "route", "show", "default").split('"dev":"')[1].split('"')[0]


def own_mac(interface):
    with open(f"/sys/class/net/{interface}/address", encoding="ascii") as handle:
        return handle.read().strip()


def v6_neighbors(interface):
    with socket.socket(socket.AF_INET6, socket.SOCK_RAW, socket.IPPROTO_ICMPV6) as sock:
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_IF, socket.if_nametoindex(interface))
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_LOOP, 0)
        sock.settimeout(REPLY_TIMEOUT)
        sock.sendto(struct.pack("!BBHHH", 128, 0, 0, os.getpid() & 0xFFFF, 1), ("ff02::1", 0, 0, socket.if_nametoindex(interface)))
        found = set()
        deadline = time.monotonic() + REPLY_TIMEOUT * 2
        while time.monotonic() < deadline:
            try:
                data, peer = sock.recvfrom(1024)
            except TimeoutError:
                break
            if data[0] == 129:
                found.add(peer[0])
        return sorted(found)


def send_arp_claim(interface, claimed_ip, target_ip):
    mac = bytes.fromhex(own_mac(interface).replace(":", ""))
    broadcast = b"\xff" * 6
    frame = broadcast + mac + struct.pack("!H", 0x0806) + struct.pack("!HHBBH", 1, 0x0800, 6, 4, 2)
    frame += mac + socket.inet_aton(claimed_ip) + broadcast + socket.inet_aton(target_ip)
    with socket.socket(socket.AF_PACKET, socket.SOCK_RAW) as sock:
        sock.bind((interface, 0))
        for _ in range(3):
            sock.send(frame)
            time.sleep(0.2)


async def check_internet():
    for address in ("1.1.1.1", "9.9.9.9"):
        state = await tcp(address, 443)
        report(f"internet: tcp {address}:443 is open", state == "open", state)
    report("internet: udp dns to 1.1.1.1 answers", udp("1.1.1.1", 53) == "open")
    try:
        request = urllib.request.Request("https://api.mistral.ai/", method="GET")
        with urllib.request.urlopen(request, timeout=10, context=ssl.create_default_context()) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    except OSError as error:
        status = f"failed: {error}"
    report("internet: https to api.mistral.ai completes TLS", isinstance(status, int), status)


async def check_link(args):
    host, port = args.link.rsplit(":", 1)
    state = await tcp(host, int(port))
    report(f"orchestrator: link {args.link} is open", state == "open", state)


async def check_control_ports(args, all_ports):
    host, port = args.link.rsplit(":", 1)
    found = await scan(host, all_ports, allowed=(int(port),))
    report(f"orchestrator: every other tcp port on {host} is blocked ({len(all_ports) - 1} ports)", not found, found[:20])
    for udp_port in SAMPLE_UDP_PORTS:
        state = udp(host, udp_port)
        report(f"orchestrator: udp {host}:{udp_port} is blocked", state == "blocked", state)


async def check_addresses(args, all_ports):
    machines = {
        "proxmox-lan": args.host_lan,
        "proxmox-on-vm-network": args.gateway,
        "proxmox-on-control-network": args.control_gateway,
        "control-lan": args.control_lan,
    }
    if args.control_tailnet:
        machines["control-tailnet"] = args.control_tailnet
    for name, address in machines.items():
        found = await scan(address, all_ports)
        report(f"{name}: every tcp port on {address} is blocked ({len(all_ports)} ports)", not found, found[:20])
        report(f"{name}: ping {address} gets no reply", not ping(address))
        for udp_port in SAMPLE_UDP_PORTS:
            state = udp(address, udp_port)
            report(f"{name}: udp {address}:{udp_port} is blocked", state == "blocked", state)

    report("lan-router: ping gets no reply", not ping(args.router))
    found = await scan(args.router, SAMPLE_PORTS)
    report(f"lan-router: tcp on {args.router} is blocked", not found, found)
    state = udp(args.router, 53)
    report(f"lan-router: dns on {args.router} is blocked", state == "blocked", state)

    prefix = args.host_lan.rsplit(".", 1)[0]
    limit = asyncio.Semaphore(SCAN_CONCURRENCY)

    async def sweep(host, port):
        async with limit:
            return f"{prefix}.{host}:{port}", await tcp(f"{prefix}.{host}", port, SCAN_TIMEOUT)

    outcomes = await asyncio.gather(*(sweep(host, port) for host in range(1, 255) for port in (22, 80, 443, 8006)))
    reached = [f"{target}={state}" for target, state in outcomes if state != "blocked"]
    report(f"lan: a sweep of {prefix}.0/24 reaches nothing", not reached, reached[:20])

    for name, address in RESERVED_V4.items():
        found = await scan(address, [22, 80, 443])
        report(f"{name}: tcp to {address} is blocked", not found, found)
        report(f"{name}: ping {address} gets no reply", not ping(address))
        state = udp(address, 53)
        report(f"{name}: udp dns to {address} is blocked", state == "blocked", state)


async def check_peer(args, interface):
    peer = args.peer
    report(f"peer: ping {peer} gets no reply", not ping(peer))
    found = await scan(peer, SAMPLE_PORTS)
    report(f"peer: tcp to {peer} on the shared network is blocked", not found, found)
    run("ip", "route", "replace", f"{peer}/32", "via", args.gateway, "dev", interface)
    try:
        found = await scan(peer, SAMPLE_PORTS)
        report(f"peer: tcp to {peer} routed through the gateway is blocked", not found, found)
    finally:
        run("ip", "route", "del", f"{peer}/32")


async def check_v6(args, interface):
    with contextlib.suppress(OSError):
        neighbors = v6_neighbors(interface)
        report("ipv6: ping ff02::1 gets no reply from another machine", not neighbors, neighbors)
    targets = ["2606:4700:4700::1111"] + ([args.control_tailnet6] if args.control_tailnet6 else [])
    for address in targets:
        state = await tcp(address, 443)
        report(f"ipv6: tcp {address}:443 is blocked", state == "blocked", state)


async def check_spoofing(args, interface):
    host, port = args.link.rsplit(":", 1)
    for label, fake in (("an unassigned address", args.spoof), ("the peer's address", args.peer)):
        run("ip", "addr", "add", f"{fake}/32", "dev", interface)
        try:
            for target, target_port in (("1.1.1.1", 443), (host, int(port))):
                state = await tcp(target, target_port, source=fake)
                report(f"spoof: source {label} to {target}:{target_port} is blocked", state == "blocked", state)
        finally:
            run("ip", "addr", "del", f"{fake}/32", "dev", interface)

    original = own_mac(interface)
    run("ip", "link", "set", "dev", interface, "address", "02:00:00:bb:07:01")
    try:
        state = await tcp("1.1.1.1", 443)
        report("spoof: a changed MAC address cannot reach the internet", state == "blocked", state)
    finally:
        run("ip", "link", "set", "dev", interface, "address", original)
    state = "blocked"
    for _ in range(10):
        state = await tcp("1.1.1.1", 443)
        if state == "open":
            break
        await asyncio.sleep(1)
    report("spoof: the real MAC address works again afterward", state == "open", state)

    send_arp_claim(interface, args.peer, args.gateway)
    report("spoof: sent an ARP claim for the peer's address", True, "the host-side script checks the result")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--link", required=True)
    parser.add_argument("--peer", required=True)
    parser.add_argument("--spoof", required=True)
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--control-gateway", required=True)
    parser.add_argument("--host-lan", required=True)
    parser.add_argument("--control-lan", required=True)
    parser.add_argument("--router", required=True)
    parser.add_argument("--control-tailnet", default="")
    parser.add_argument("--control-tailnet6", default="")
    parser.add_argument("--quick", action="store_true")
    args = parser.parse_args()

    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    resource.setrlimit(resource.RLIMIT_NOFILE, (min(4096, hard), hard))

    interface = default_interface()
    all_ports = SAMPLE_PORTS if args.quick else list(range(1, 65536))
    await check_internet()
    await check_link(args)
    await check_control_ports(args, all_ports)
    await check_addresses(args, all_ports)
    await check_peer(args, interface)
    await check_v6(args, interface)
    await check_spoofing(args, interface)


asyncio.run(main())
