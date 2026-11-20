# Skillnet

Share agent skills (plain `SKILL.md` folders) privately, with friends, with an organization, or with everyone.
Every machine you set up keeps its agents' skill folders in sync, live.

- `server.js` — the whole server: Node 22.5+ built-ins only (`node:http`, `node:sqlite`). `PORT` (8795), `SKILLNET_DB`, `SKILLNET_URL` (public address, used in links and the install script).
- `public/` — the website (no build step).
- `cli/skillnet.js` — the command. Questions (`whoami`, `search`, `show`, `info`, `suggestions`), changes (`push`, `suggest`, `approve`, `require`, `rollback`…), people, keys, `sync`, `watch`. `skillnet help` lists them; `--json` on any.
- `builtin/skillnet/SKILL.md` — sent to every account's machines, so any agent can answer Skillnet questions and make changes from the chat.
- `cli/pi-skillnet-reload.ts` — Pi extension; reloads Pi when a sync changed skills (Claude Code reloads skill folders on its own).

## How it fits together

- **Visibility**: personal skills are `private`, `friends` or `public`; organization skills are `org` or `public`.
- **Organizations and roles**: **members** use skills and *suggest* changes; **editors** also change what skills say and approve suggestions; **admins** also decide who gets a skill (required/optional, visibility, delete) and manage people; **owners** also change roles. A **required** skill lands on every member's machines. Join by invite link.
- **Connecting (the main way)**: people add `<server>/mcp` as a custom connector (Claude, Cursor, VS Code, ChatGPT, any remote-MCP app) and sign in in the browser. Standard MCP OAuth: discovery at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, open app registration (`/oauth/register`), PKCE (S256) only, consent page `/oauth/authorize`, one-hour access tokens, rotating refresh tokens (`/oauth/token`), `/oauth/revoke`. Each connected app is listed on the Keys page and can be revoked. `/mcp` never reads the browser cookie. On `initialize` the server instructions carry the person's skill list (name and one line each, under 4,000 characters), so the agent knows its skills from the start; `read_skill` gives the full text, and each skill is also an MCP prompt (a slash command). Nothing is installed or cached on the machine, so leaving an organization takes effect on the next session.
- **Keys and cloud runs** (headless only): `/devices` (Keys) makes API keys, read-only or read-write. Cloud agents put one in `SKILLNET_KEY` and either run `curl -H "Authorization: Bearer $SKILLNET_KEY" <server>/api/pull.sh | sh` (needs only sh, curl, base64; `SKILLNET_DIRS` picks folders) or the CLI, which reads `SKILLNET_KEY`/`SKILLNET_URL`. The Connect page has the exact snippet for Claude Code cloud, Cursor, Codex and MCP clients.
- **MCP**: `POST /mcp` with a connector token or an API key as the bearer token. Tools: `search_skills`, `read_skill`, `skill_info`, `my_account`, `publish_skill`, `suggest_change`. The CLI's plain-text answers come from the same tools.
- **Versions**: every push with a change is a new version; roll back from the skill page (it becomes a new version, so machines update forward).
- **Sync**: `GET /api/manifest` lists what this person should have; `skillnet watch` holds `GET /api/events` (server-sent events) open and syncs on every `sync` event, plus every 15 minutes as a safety net. Synced folders carry `.skillnet.json`; folders without it are never touched, and locally edited synced folders are never overwritten or deleted.
- **Targets**: every existing agent skill folder (`~/.claude/skills`, `~/.pi/agent/skills`, `~/.codex/skills`, `~/.agents/skills`, `~/.cursor/skills`, `~/.gemini/skills`); linked folders are written once. Override with `"targets"` in `~/.config/skillnet/config.json`.
- **Sign-in on machines**: device code (the command shows a code, you approve it on the site). Each machine gets its own token, listed and revocable under Devices.

## Run

    npm test
    SKILLNET_URL=https://skills.example.com node server.js

## Later: agent chat and a shared tool gateway

The same people, friends, organizations and device tokens are the base for both:
- **Agent chat**: a `messages` table (from token/agent, to user/org/channel) delivered over the same event stream.
- **Tool gateway**: organizations register MCP servers/API keys once; the server proxies calls and checks the caller's organization role and a per-tool grant, so no one sets up their own connectors or holds the keys.
