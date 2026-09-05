# GitHub sign-in, for operators

Iris has one identity provider and it is not optional: every request carries a user's GitHub token,
and that token is what files the session's contributions under that user's own name. The
[README](../README.md#github-is-the-only-sso-layer-and-tokens-are-required) says why. This file is
the part you need to *deploy* it — registering your own app, what a private upstream can and cannot
do, and what to do with a database from an older build.

By default you need none of it: the bundled GitHub App and the device flow work with no setup and no
secret, the same way the `gh` CLI does.

## Two consequences before you deploy

**1. The permission lives with the installation, not with your users.** The token does exactly two
things: `GET /user` to identify the caller, and file issues on `upstream_repo`. Iris is registered as
a **GitHub App**, so the second one is granted once — by installing the app on `upstream_repo` with
`issues: write` — and users only *authorize*. Their consent screen requests **no repository access
at all**, because there is nothing left for it to ask for.

One limit worth knowing if your `upstream_repo` is **private**: a user's token is the *intersection*
of the installation's permissions and that user's own access, so installing the app does not give a
user access they did not already have. On a private upstream, filing works for users who can see the
repo and 404s for everyone else. Set `github.issue_token` if you need a private upstream to accept
contributions from users who are not collaborators — it files everything under one account, which
trades away the per-user attribution below. A public `upstream_repo` (the assumption here, since the
agent library is meant to be shared) has no such limit.

This replaced an OAuth App requesting `public_repo`, and the reason is worth stating plainly: there
is no OAuth scope meaning "open issues on one repository". `public_repo` was the narrowest one that
could file, and it grants read **and write** to every public repository the user can reach —
code, commit statuses, collaborators, webhooks — none of which Iris touches. Nothing pushes and
nothing opens pull requests. So the old consent screen asked for orders of magnitude more than the
service uses, and the app is the only way to fix that rather than merely document it.

What the user's token still carries is their **identity**. A user-to-server token acts as the user,
so issues are filed under their own account and each contribution is credited to the person whose
session produced it — the whole reason users authorize at all instead of the app filing as itself.

**2. `github.issue_token` is an override, and not a recommended one.** Set it to a service-account
PAT and every issue is filed under that bot account instead of under the user who produced it. It is
off by default because it erases the attribution that is the point of the design. Use it only where
a deployment genuinely cannot file as its users — an org policy that forbids it, say.

## Registering your own app

Two settings the service depends on, if you point `github.client_id` at your own GitHub App:

| Setting | Value | Why |
| --- | --- | --- |
| **Enable Device Flow** | on | Off by default for a new app, and the device flow is the default deployment's only login path (it returns `device_flow_disabled` without it). |
| **Expire user authorization tokens** | **off** | With expiry on, user tokens last 8 hours and come with a refresh token. Nothing here persists or refreshes a credential, so turning expiry on means building refresh plumbing first. |

The misconfiguration this *cannot* catch at startup is the app not being installed on
`upstream_repo` — that state lives on github.com, not in config. It surfaces as a **403 or 404**
during filing, logged with a `hint` saying so. Both statuses, because GitHub does not reveal
repositories a credential cannot see: an app that was never installed reads as `404 Not Found`
rather than as a permissions error. (A misspelled `upstream_repo` looks identical, and the hint says
so rather than blaming the installation.) When `issue_token` is set, the hint names the **service
PAT** instead, since the installation governs only tokens issued to users.

## Coming from an earlier build

Three things changed, and two of them can stop a working deployment:

- **A configured OAuth App id is now a hard startup failure.** An `Ov…` `client_id` is refused,
  because Iris no longer sends any OAuth scope: such an app would authenticate users and then be
  unable to file a single issue. Register a GitHub App (`Iv…`) and install it on your
  `upstream_repo`, or leave `client_id` blank for the bundled one.
- **`upstream_repo` is no longer independent of `client_id`.** Under the old OAuth App, the
  `public_repo` scope could file on any public repo, so leaving `client_id` blank and repointing
  `upstream_repo` at your own agent library worked. A GitHub App's `issues: write` comes from its
  *installation* on one specific repository, and the bundled app is installed on this repo — so that
  same config now files nothing, for anyone. You need your own app installed on your repo (or ask us
  to install ours there). This combination warns at startup rather than failing, since we cannot see
  from config whether the bundled app was installed on your repo.
- **`github.oauth_scope` is gone.** A config that still sets it — including `oauth_scope: none`,
  which used to be a startup error — now starts fine and ignores the key. Delete it.

There is no user-facing migration: no one had authorized the OAuth App, and any existing
authorization can be revoked at
[github.com/settings/applications](https://github.com/settings/applications).

## What happens to a token

**It is never written to disk.** The token arrives in the `Authorization` header, is used in memory
for the request and for the pipeline run it authorizes, and is gone when the run ends. There is no
`github_token` column in `data/iris.sqlite` and no token file — a stolen copy of the database is a
list of GitHub user IDs and logins, not GitHub access.

Two smaller things follow from that, both worth knowing:

- Identity lookups (`GET /user`) are cached in memory for **5 minutes**, keyed by the token, so a
  revoked token keeps working for up to that long. The cache is bounded (10,000 entries, oldest
  evicted) and entries are *not* renewed on use — deliberately, so that a busy token cannot outlive
  its revocation indefinitely. It is empty on restart.
- Because nothing is stored, there is nothing to rotate, re-encrypt or purge when a user revokes
  access. Revocation at github.com is the whole mechanism.

**If you have a `data/iris.sqlite` from an earlier build, delete it.** Tokens *were* stored in a
`github_token` column once, and there is no migration — every user re-authorizes from scratch. The
service refuses to start against such a file and names the fix, rather than adopting it: the old
table's `github_token TEXT NOT NULL` would survive `CREATE TABLE IF NOT EXISTS`, so first-time
logins would fail with a SQLite constraint error returned as `401 unauthorized` (users who already
had a row would keep working, which makes it look like flaky GitHub auth rather than a schema
mismatch) — and the claim above would be false for that file, since it still holds live plaintext
tokens for everyone who ever logged in. Delete it rather than archiving it; users lose only their
session history.
