# Brief for Claude in Chrome: create Ke'Ebonie's Google sign-in credentials

Copy everything below the line into Claude in Chrome. Grant it access to
`console.cloud.google.com` first, and have her Google account
(**keeboniehill@gmail.com**) already signed in in that tab.

This produces two values, a **Client ID** and a **Client secret**, that let her
booking site offer "Continue with Google." Nothing here costs money.

---

You are creating a Google OAuth client for a client, Ke'Ebonie Hill, in **her
own Google account**. Work only in the browser.

## 0. Verify the account first

Go to `https://console.cloud.google.com`. Confirm the signed-in account is
**keeboniehill@gmail.com** (top-right avatar). If it is any other account,
**stop and say so** before doing anything.

## 1. Project

Create a new project (top bar project picker, "New Project") named
**Sitting Pretty**, or select it if it already exists. Wait for it to be
created and make sure it is the selected project. Report the project name.

## 2. Consent screen / branding

Google has been renaming this area (it may be called "OAuth consent screen",
"Google Auth Platform", or "Branding"). Find the place where you configure what
users see when they sign in, and set:

- **User type / Audience: External** (so her actual clients can sign in, not
  just test accounts).
- **App name:** Sitting Pretty
- **User support email:** keeboniehill@gmail.com
- **Developer contact email:** keeboniehill@gmail.com
- Leave logo, app domain, and everything optional blank.
- **Scopes:** do NOT add any. The default email / profile / openid scopes are
  all this needs, and they do not trigger Google's verification review.

**Then PUBLISH the app / set Publishing status to "In production"** (there is
usually a "Publish app" button, or an Audience setting of "Production" vs
"Testing"). If it is left in "Testing", only manually-added test users can sign
in and every real client is turned away. Publishing basic-scope apps is instant,
with no review. Report the publishing status you end on.

## 3. Create the OAuth client

Go to **Credentials** (or "Clients") → **Create credentials** → **OAuth client
ID** → Application type **Web application**. Name it **Sitting Pretty Web**.

Add these EXACTLY (copy-paste, do not retype):

**Authorized JavaScript origins:**
```
https://taylormadecreative.github.io
https://zfffguimcawjxtbiesqn.supabase.co
```

**Authorized redirect URIs:**
```
https://zfffguimcawjxtbiesqn.supabase.co/auth/v1/callback
```

The redirect URI is the one thing that breaks sign-in if it is off by a single
character. Double-check it matches exactly, including `https://`, no trailing
slash, and `/auth/v1/callback` at the end.

Click **Create**.

## 4. Report back

Google shows a **Client ID** and a **Client secret** once. Copy **both** into
your reply, clearly labelled. Also report:

- the project name
- the publishing status (Production or Testing)
- confirmation that the redirect URI was accepted without an error

## Rules

- Do NOT enable billing, add payment methods, or turn on any paid API.
- Do NOT add scopes beyond the defaults.
- Do NOT delete or change any other project or credential in the account.
- The Client secret is sensitive. Report it once here so it can be stored, and
  do not paste it into any other site or form.
- If a screen looks different from these steps (Google moves this UI often),
  describe what you see and ask rather than guessing.
