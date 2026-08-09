# Brief for Claude in Chrome: set up Ke'Ebonie's Supabase project

Copy everything below the line into Claude in Chrome. Grant it access to
supabase.com first, and have her Supabase tab already signed in.

---

You are setting up a Supabase project for a client, Ke'Ebonie Hill, in **her
own account**. Work only in the browser. Do not use a terminal.

## Before you touch anything

1. Go to `https://supabase.com/dashboard`.
2. Find the signed-in account's email (usually top-right avatar, or account
   settings). **It must be `keeboniehill@gmail.com`.**
3. If it is any other address, especially anything ending in
   `@taylormadecreative` or a personal account with projects named
   `taylormade-studio`, `rosies-beauty-spa`, or `runitup-dallas`: **stop and
   say so.** That is the developer's account. Creating her project there puts a
   client's business in the wrong org and is painful to undo later.

Report the email you found before continuing.

## 1. Create her project

Only if one does not already exist. First list the projects you can see and
report them. If something like "sitting pretty" is already there, stop and
report it rather than making a second one.

Otherwise create a new project:

- **Name:** `sitting-pretty`
- **Region:** the closest one to Texas (usually East US or Central US). Report
  which you chose.
- **Database password:** generate a strong one, and **copy it into your reply.**
  Supabase shows this exactly once and it cannot be recovered. If you do not
  capture it here, it is gone.
- Free tier / default plan.

Wait for provisioning to finish (a minute or two). Say when it is ready.

## 2. Collect the connection details

From the project, go to **Settings → API** (or "API Keys" / "Project Settings",
the label moves around). Copy out:

- **Project URL** (looks like `https://abcdefghijk.supabase.co`)
- **Project reference ID** (the subdomain part, or shown as "Reference ID")
- **anon / public key** (a long JWT starting `eyJ...`, safe to put in a website)
- **service_role key** (also `eyJ...`, marked secret or hidden behind "Reveal")

Report all four. Flag clearly which one is the service_role key.

## 3. Generate an access token

Go to account settings → **Access Tokens** (usually
`https://supabase.com/dashboard/account/tokens`).

- Generate a new token named `sitting-pretty-deploy`
- **Copy the token into your reply.** It is shown once only.

## 4. Turn on the sign-in methods

Project → **Authentication → Providers** (or "Sign In / Providers"):

- **Email**: make sure it is enabled, with password sign-in allowed.
- Report whether "Confirm email" is currently on or off. Do not change it, just
  report it.
- **Google**: report whether it is enabled and whether it is asking for a Client
  ID and Secret. Do not fill anything in; those credentials do not exist yet.

Then Authentication → **URL Configuration**: report the current **Site URL** and
anything in the **Redirect URLs** allow-list. Do not change them yet.

## 5. Report back

Give a single summary containing:

- the signed-in email you verified in step 0
- project name, region, reference ID, project URL
- the database password
- the anon key
- the service_role key
- the access token
- what you found for Email provider, confirm-email, Google provider, Site URL,
  and redirect URLs

## Rules

- **Do not** paste any SQL, create tables, or run anything in the SQL Editor.
  That is being handled separately.
- **Do not** change billing, delete anything, or invite collaborators.
- **Do not** modify Site URL or redirect URLs. Only report them.
- If any screen looks different from these instructions, describe what you see
  and ask, rather than guessing. Supabase moves its UI around and a wrong click
  in the wrong account is worse than a pause.
- The service_role key, the database password, and the access token are all
  secrets. Report them once here so they can be stored properly, and do not
  paste them into any website, form, or search box.
