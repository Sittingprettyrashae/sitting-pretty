#!/bin/bash
# Move the site to sittingprettyrashae.com. Run ONLY after
# scripts/check-domain-dns.sh passes, or the github.io URL will redirect to a
# domain that is not resolving yet and look broken.
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="sittingprettyrashae.com"
NEW="https://${DOMAIN}"
# The repo now lives under her account. This is where Pages + HTTPS get set.
REPO="Sittingprettyrashae/sitting-pretty"

echo "Confirming DNS first..."
if ! scripts/check-domain-dns.sh >/dev/null 2>&1; then
  echo "DNS is not pointing at GitHub yet. Aborting so the live site stays up." >&2
  echo "Run scripts/check-domain-dns.sh to see where it stands." >&2
  exit 1
fi

echo "1/5 CNAME file (this is what tells GitHub Pages the custom domain)..."
printf '%s\n' "$DOMAIN" > CNAME

echo "2/5 link-preview + canonical URLs in index.html..."
python3 - "$NEW" <<'PY'
import re, sys
new = sys.argv[1]
p = "index.html"; s = open(p).read()
# Replace ANY of the project's github.io hosts (whichever account it was on)
# with the custom domain, keeping /assets/... paths and normalising the root.
s = re.sub(r"https://[a-z0-9-]+\.github\.io/sitting-pretty(/assets/)", new + r"\1", s)
s = re.sub(r"https://[a-z0-9-]+\.github\.io/sitting-pretty/?", new + "/", s)
open(p, "w").write(s)
print("  updated", s.count(new), "references to the new domain")
PY

echo "3/5 Supabase Site URL -> new domain (allow-list already has both)..."
set -a; . ./server/.env.local; set +a
curl -s -X PATCH "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"site_url\":\"${NEW}/\"}" -o /tmp/cut.json -w "  site_url update: %{http_code}\n"

echo "4/5 GitHub Pages custom domain..."
gh api -X PUT repos/$REPO/pages -f cname="$DOMAIN" >/dev/null 2>&1 \
  || echo "  (Pages API set skipped; the CNAME file in the push also sets it)"

echo "5/5 commit + push..."
git add CNAME index.html
git commit -q -m "Point the site at sittingprettyrashae.com

Her own domain, in her Cloudflare. CNAME file plus the four link-preview and
canonical URLs and the Supabase Site URL now point at it. The Supabase
allow-list already carries both the domain and github.io, so sign-in works
throughout the switch, and github.io keeps working and redirects to the domain." \
  || echo "  (nothing to commit)"
git push -q origin main && echo "  pushed"

echo
echo "Done. GitHub is issuing the HTTPS cert now (minutes to ~2 hours)."
echo "Once https://${DOMAIN} loads clean, enforce HTTPS:"
echo "  gh api -X PUT repos/$REPO/pages -f https_enforced=true"
