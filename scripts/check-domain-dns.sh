#!/bin/bash
# Passes when sittingprettyrashae.com resolves to the GitHub Pages IPs, so the
# cutover will not point the live site at a domain that is not ready.
set -uo pipefail
DOMAIN="sittingprettyrashae.com"
GH_IPS="185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153"

echo "Resolving $DOMAIN ..."
# Ask a public resolver, not the local cache, so this reflects the real world.
GOT=$(dig +short A "$DOMAIN" @1.1.1.1 2>/dev/null | sort | tr '\n' ' ')
GOT=${GOT:-$(dig +short A "$DOMAIN" @8.8.8.8 2>/dev/null | sort | tr '\n' ' ')}
echo "  apex A records: ${GOT:-<none yet>}"

ok=0
for ip in $GH_IPS; do echo "$GOT" | grep -q "$ip" && ok=$((ok+1)); done

WWW=$(dig +short CNAME www."$DOMAIN" @1.1.1.1 2>/dev/null)
echo "  www CNAME: ${WWW:-<none yet>}"

echo
if [ "$ok" -ge 1 ]; then
  echo "DNS is pointing at GitHub ($ok/4 A records seen). Safe to run scripts/cutover-domain.sh"
  exit 0
fi
echo "Not ready yet. GitHub A records are not resolving. Give DNS a few more minutes."
echo "If it has been over an hour, re-check the records in her Cloudflare (grey cloud, name @)."
exit 1
