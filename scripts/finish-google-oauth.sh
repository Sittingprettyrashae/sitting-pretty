#!/bin/bash
# Finish Google sign-in once her Google OAuth client exists.
#
#   scripts/finish-google-oauth.sh "<client_id>" "<client_secret>"
#
# It configures her Supabase Google provider, verifies the change, and writes
# both googleEnabled and googleClientId into js/config.js so the button comes
# back on the dashboard and the client booking sheet. Then commit and push
# js/config.js.
#
# The id must be the WEB client, and its Authorized JavaScript origins must
# list https://sittingprettyrashae.com (plus http://localhost:<port> only while
# developing). That origin is what makes Google name her domain on the prompt
# instead of the Supabase project URL -- see js/api.js "Google, the One Tap
# way". The live site never uses a redirect URI.
set -euo pipefail
cd "$(dirname "$0")/.."

CLIENT_ID="${1:-}"
CLIENT_SECRET="${2:-}"
if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "usage: scripts/finish-google-oauth.sh \"<client_id>\" \"<client_secret>\"" >&2
  exit 1
fi

set -a; . ./server/.env.local; set +a

echo "Configuring the Google provider on her Supabase project..."
curl -s -X PATCH "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"external_google_enabled\":true,\"external_google_client_id\":\"$CLIENT_ID\",\"external_google_secret\":\"$CLIENT_SECRET\"}" \
  -o /tmp/g-conf.json -w "  config update: %{http_code}\n"

python3 - <<'PY'
import json
d = json.load(open("/tmp/g-conf.json"))
print("  google enabled:", d.get("external_google_enabled"))
print("  client id set:", bool(d.get("external_google_client_id")))
if not d.get("external_google_enabled"):
    raise SystemExit("Google did not enable; check the client id/secret and try again.")
PY

echo "Flipping the frontend flag and writing the client id..."
CLIENT_ID="$CLIENT_ID" python3 - <<'PY'
import os, re
cid = os.environ["CLIENT_ID"]
p = "js/config.js"; s = open(p).read()
s = s.replace("  googleEnabled: false,", "  googleEnabled: true,")
# The client id is public by design, and it is what puts HER domain rather
# than the Supabase project URL on the Google prompt. The client SECRET went
# to Supabase above and must never land in this file.
s = re.sub(r'  googleClientId: "[^"]*",', '  googleClientId: "%s",' % cid, s)
open(p, "w").write(s)
print("  js/config.js googleEnabled ->", "true" if "googleEnabled: true," in s else "UNCHANGED")
print("  js/config.js googleClientId ->", "set" if cid in s else "UNCHANGED")
PY

echo
echo "Done. Now: git add js/config.js && git commit && git push, then wait for"
echo "the Pages deploy and test the Google button on the live dashboard."
