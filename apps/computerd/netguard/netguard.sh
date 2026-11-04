#!/bin/sh
# Applies the outbound rules for the network namespace computerd joins, then stays alive to hold that namespace.
set -eu

BLOCKED_V4="127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 0.0.0.0/8 224.0.0.0/4"
BLOCKED_V6="::1/128 fc00::/7 fe80::/10 ff00::/8 ::ffff:0:0/96"

# The final accept goes in last, so finding it means every rule before it is in place.
if [ "${1:-}" = check ]; then
  iptables -C OUTPUT -j ACCEPT
  ip6tables -C OUTPUT -j ACCEPT
  exit 0
fi

link=$(printf '%s' "$COMPUTER_LINK_URL" | sed -nE 's#^wss?://([^/:]+):([0-9]+)(/.*)?$#\1 \2#p')
if [ -z "$link" ]; then
  echo "netguard: COMPUTER_LINK_URL must name a host and a port: $COMPUTER_LINK_URL" >&2
  exit 1
fi
link_host=${link% *}
link_port=${link#* }

# Everything is dropped from the first command on, so a failure at any later line leaves no way out.
for table in iptables ip6tables; do
  "$table" -P OUTPUT DROP
  "$table" -F OUTPUT
  "$table" -A OUTPUT -o lo -j ACCEPT
  "$table" -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done

# No IPv6 packet can leave without neighbor discovery, and these messages never go past the local link.
for type in router-solicitation neighbour-solicitation neighbour-advertisement; do
  ip6tables -A OUTPUT -p ipv6-icmp --icmpv6-type "$type" -j ACCEPT
done

v4=$(getent ahostsv4 "$link_host" | awk '{ print $1 }' | sort -u)
v6=$(getent ahostsv6 "$link_host" | awk '!/^::ffff:/ { print $1 }' | sort -u)
if [ -z "$v4$v6" ]; then
  echo "netguard: $link_host does not resolve" >&2
  exit 1
fi
for address in $v4; do
  iptables -A OUTPUT -p tcp -d "$address" --dport "$link_port" -j ACCEPT
done
for address in $v6; do
  ip6tables -A OUTPUT -p tcp -d "$address" --dport "$link_port" -j ACCEPT
done

for range in $BLOCKED_V4; do
  iptables -A OUTPUT -d "$range" -j REJECT
done
for range in $BLOCKED_V6; do
  ip6tables -A OUTPUT -d "$range" -j REJECT
done
iptables -A OUTPUT -j ACCEPT
ip6tables -A OUTPUT -j ACCEPT

echo "netguard: link $link_host port $link_port, v4 [$v4], v6 [$v6]"
exec sleep infinity
