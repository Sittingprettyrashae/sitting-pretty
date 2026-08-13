#!/bin/bash
# Run AFTER she has (1) accepted the repo transfer and (2) added
# "taylormadecreative" as a collaborator with Admin on her repo. This repoints
# the local git remote at her repo, enables GitHub Pages (Actions source), and
# kicks a deploy, so the site is served from HER account.
set -uo pipefail
cd "$(dirname "$0")/.."

REPO="Sittingprettyrashae/sitting-pretty"

echo "1/5 Is the repo hers now, and can this CLI reach it?"
if ! gh api "repos/$REPO" --jq '.full_name' >/dev/null 2>&1; then
  echo "  Cannot see $REPO with this login." >&2
  echo "  She must ACCEPT the transfer, then add 'taylormadecreative' as a" >&2
  echo "  collaborator (Admin) and this account must accept that invite:" >&2
  gh api user/repository_invitations --jq '.[] | "    pending invite: \(.repository.full_name) (id \(.id))"' 2>/dev/null || true
  echo "  Accept an invite with: gh api -X PATCH user/repository_invitations/<id>" >&2
  exit 1
fi
echo "  OK: $(gh api "repos/$REPO" --jq '.full_name'), admin=$(gh api "repos/$REPO" --jq '.permissions.admin')"

echo "2/5 Point local git remote at her repo..."
git remote set-url origin "https://github.com/$REPO.git"
echo "  origin -> $(git remote get-url origin)"

echo "3/5 Enable Pages (GitHub Actions source) on her repo..."
gh api -X POST "repos/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 \
  && echo "  Pages enabled" \
  || gh api -X PUT "repos/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 \
     && echo "  Pages source set to Actions" \
     || echo "  (Pages may already be enabled; continuing)"

echo "4/5 Trigger a deploy..."
gh workflow run pages.yml -R "$REPO" >/dev/null 2>&1 \
  && echo "  deploy triggered" \
  || echo "  (could not trigger via API; push any commit, or Actions tab > Run workflow)"

echo "5/5 Her Pages URL (works until the custom domain cuts over):"
echo "  https://sittingprettyrashae.github.io/sitting-pretty/"
echo
echo "Once that URL loads, do the domain: add the DNS records in her Cloudflare"
echo "(DOMAIN-SETUP.md), run scripts/check-domain-dns.sh, then scripts/cutover-domain.sh."
