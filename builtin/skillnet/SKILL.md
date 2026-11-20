---
name: skillnet
description: Use when the user asks about shared skills or Skillnet - which skills they, their friends or their organization have, what a skill says, who can change it, its history - or wants to publish, update, suggest a change to, share, install, remove or roll back a skill, approve suggestions, manage organization members and roles, or make an API key.
---

# Skillnet

Skillnet ({{URL}}) shares agent skills between people and organizations and keeps them in sync on every machine.
Answer the user's questions yourself with the commands below; do not send them to the website unless they ask.

## Pick the way in

1. Skillnet connector tools available (search_skills, read_skill, skill_info, my_account, publish_skill, suggest_change): use them. This is the usual way in.
2. `skillnet` command on PATH: use it (add `--json` to any command for exact data).
3. No command but `SKILLNET_KEY` is set (cloud runs): run it without installing:
   `curl -fsSL {{URL}}/cli/skillnet.js -o /tmp/skillnet.js && node /tmp/skillnet.js <command>`
   It reads `SKILLNET_KEY` and `SKILLNET_URL` (default {{URL}}).
4. No Node: call the HTTP API with `curl -H "Authorization: Bearer $SKILLNET_KEY" {{URL}}/api/...`
   (`/api/me`, `/api/skills?q=`, `/api/resolve?ref=owner/name`, `/api/skills/<id>`, `/api/skills/<id>/file?path=`).

To connect a new app, the user adds a custom connector (remote MCP server) with the address {{URL}}/mcp and signs in; the Connect page has steps per app.

Not signed in: `skillnet login {{URL}}` prints a link and code; tell the user to open it and approve.

## Answering questions

| Question | Command |
|---|---|
| Who am I, my organizations and roles | `skillnet whoami` |
| Is there a skill for X / what does our team have | `skillnet search X` |
| What does a skill say | `skillnet show owner/name` (add a file path for other files) |
| Who changed it, when, who can edit it | `skillnet info owner/name` |
| What is on this machine | `skillnet list` |
| Organization members and roles | `skillnet org show <org>` |
| Waiting suggestions | `skillnet suggestions` |

## Making changes

- Publish or update from a folder with SKILL.md: `skillnet push <dir> [--org <org>] [--visibility private|friends|org|public] [--note "what changed"]`.
- Without edit rights, suggest instead: `skillnet suggest <dir> --to owner/name --note "why"`. An editor approves it.
- Approve or decline: `skillnet approve <id>`, `skillnet decline <id>`.
- Add or drop someone's skill on all your machines: `skillnet install owner/name`, `skillnet remove owner/name`.
- Required for the whole organization: `skillnet require owner/name`; back to optional: `skillnet optional owner/name`.
- Roll back: `skillnet rollback owner/name <version>`.
- Keys for cloud runs: `skillnet key create "Cursor cloud" [--write]`.

Roles in an organization: **members** use skills and suggest changes; **editors** also change what skills say;
**admins** also decide who gets them (required, visibility, delete) and manage people; **owners** also change roles.

After a push or approval, every machine updates within seconds. Pi reloads by itself; Claude Code picks up skill folders on its own.
Confirm changes with the user before publishing, making a skill required, or deleting.
