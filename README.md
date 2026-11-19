# Skillnet

Share agent skills (plain `SKILL.md` folders) privately, with friends, with an organization, or with everyone.
Every machine you set up keeps its agents' skill folders in sync, live.

- `server.js` — the whole server: Node 22.5+ built-ins only (`node:http`, `node:sqlite`). `PORT` (8795), `SKILLNET_DB`, `SKILLNET_URL` (public address, used in links and the install script).
- `public/` — the website (no build step).
- `cli/skillnet.js` — the command: `setup`, `push`, `install`, `remove`, `list`, `sync`, `watch`.
- `cli/pi-skillnet-reload.ts` — Pi extension; reloads Pi when a sync changed skills (Claude Code reloads skill folders on its own).

## How it fits together

- **Visibility**: personal skills are `private`, `friends` or `public`; organization skills are `org` or `public`.
- **Organizations**: owners/admins publish; a skill marked **required** lands on every member's machines and cannot be removed by them. Optional ones are added per person. Join by invite link.
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
