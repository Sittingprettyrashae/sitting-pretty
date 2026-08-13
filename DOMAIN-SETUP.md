# Pointing sittingprettyrashae.com at her site

Domain is in **her** Cloudflare account (Sittingprettyrashae). Do DNS FIRST,
then run the cutover script. Doing it the other way makes the working github.io
URL redirect to a domain that is not resolving yet, which looks like a dead site
until DNS propagates.

## Step 1 — Add these DNS records in her Cloudflare

Cloudflare dashboard → sittingprettyrashae.com → DNS → Records. Add all of these.

**Every one of these must be "DNS only" (grey cloud), NOT proxied (orange).**
GitHub issues the HTTPS certificate by reaching the real origin; the orange
cloud hides it and the cert never issues.

Apex (`sittingprettyrashae.com`) — four A records, all with name `@`:

| Type | Name | Value           | Proxy    |
|------|------|-----------------|----------|
| A    | @    | 185.199.108.153 | DNS only |
| A    | @    | 185.199.109.153 | DNS only |
| A    | @    | 185.199.110.153 | DNS only |
| A    | @    | 185.199.111.153 | DNS only |

www redirect:

| Type  | Name | Value                        | Proxy    |
|-------|------|------------------------------|----------|
| CNAME | www  | sittingprettyrashae.github.io | DNS only |

(Optional IPv6, same idea, name `@`, type AAAA: `2606:50c0:8000::153`,
`2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.)

If Cloudflare already added its own A/AAAA or a parking CNAME on `@` when the
domain was registered, delete those first so only the four GitHub A records
remain on the apex.

## Step 2 — Check DNS is pointing at GitHub

Wait a few minutes, then:

```sh
scripts/check-domain-dns.sh
```

It passes when the apex resolves to the GitHub Pages IPs. Do not cut over until
it does.

## Step 3 — Cut over

```sh
scripts/cutover-domain.sh
```

This writes the CNAME file, points the four link-preview URLs and the Supabase
Site URL at the new domain, sets the GitHub Pages custom domain, commits, and
pushes. GitHub then issues the certificate (a few minutes up to a couple hours).
The github.io URL keeps working and just redirects to the new one.

After the cert is live, enforce HTTPS:

```sh
gh api -X PUT repos/Sittingprettyrashae/sitting-pretty/pages -f https_enforced=true
```

## What she gets

- `https://sittingprettyrashae.com` — her booking site
- `https://www.sittingprettyrashae.com` — redirects to the above
- Sign-in and link previews already know about the domain (Supabase allow-list
  updated 2026-08-13).

When Google sign-in is set up later, add `https://sittingprettyrashae.com` to
the Authorized JavaScript origins in her Google OAuth client too.
