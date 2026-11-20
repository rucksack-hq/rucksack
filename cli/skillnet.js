#!/usr/bin/env node
// skillnet: sign in, publish skills, and keep this machine's agent skill folders in sync with the server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CONF_DIR = process.env.SKILLNET_HOME || path.join(HOME, '.config', 'skillnet');
const CONF = path.join(CONF_DIR, 'config.json');
const CHANGED = path.join(CONF_DIR, 'changed'); // touched after every sync that changed files; the Pi extension watches it
const MARKER = '.skillnet.json';
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', MARKER]);
// Skill folders of each agent. Claude Code hot-reloads ~/.claude/skills; Pi reloads through the skillnet extension.
const KNOWN_TARGETS = ['.claude/skills', '.pi/agent/skills', '.codex/skills', '.agents/skills', '.cursor/skills', '.gemini/skills'];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
// SKILLNET_KEY / SKILLNET_URL (cloud runs, CI) win over the saved sign-in.
const conf = () => {
  const c = readJson(CONF, {});
  if (process.env.SKILLNET_KEY) c.token = process.env.SKILLNET_KEY;
  if (process.env.SKILLNET_URL) c.server = process.env.SKILLNET_URL.replace(/\/+$/, '');
  return c;
};
const saveConf = (c) => { fs.mkdirSync(CONF_DIR, { recursive: true }); fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 }); };
const log = (...a) => console.log(...a);
const die = (msg) => { console.error(`skillnet: ${msg}`); process.exit(1); };

async function api(method, p, body, c = conf()) {
  if (!c.server) die('not signed in; run: skillnet setup <server-url>');
  const res = await fetch(c.server + p, {
    method, headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30e3),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(out.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return out;
}

export function targets(c = conf()) {
  const list = c.targets || KNOWN_TARGETS.map((t) => path.join(HOME, t)).filter((t) => fs.existsSync(path.dirname(t)));
  const seen = new Set(), out = [];
  for (const t of list) {
    fs.mkdirSync(t, { recursive: true });
    const real = fs.realpathSync(t); // ~/.claude/skills is often a link to another agent's folder
    if (!seen.has(real)) { seen.add(real); out.push(real); }
  }
  return out;
}

// Same hash the server computes: sha256 over sorted "path\0base64" pairs.
export function readFolder(dir) {
  const files = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d)) {
      if (SKIP.has(e) || e.includes('.skillnet-tmp-')) continue;
      const abs = path.join(d, e), r = rel ? `${rel}/${e}` : e, st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, r); else if (st.isFile()) files[r] = fs.readFileSync(abs).toString('base64');
    }
  };
  walk(dir, '');
  return files;
}
export const bundleHash = (files) => crypto.createHash('sha256').update(Object.keys(files).sort().map((p) => `${p}\0${files[p]}`).join('\0')).digest('hex');

function writeFolder(dest, files, marker) {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.skillnet-tmp-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [p, b64] of Object.entries(files)) {
    if (p.split('/').some((x) => x === '..' || x === '') || path.isAbsolute(p)) throw new Error(`refusing unsafe path ${p}`);
    const abs = path.join(tmp, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const buf = Buffer.from(b64, 'base64');
    // shortcut: bundles do not carry file modes, so scripts are marked executable by their #! line; store modes if that proves wrong.
    fs.writeFileSync(abs, buf, { mode: buf.subarray(0, 2).toString() === '#!' ? 0o755 : 0o644 });
  }
  fs.writeFileSync(path.join(tmp, MARKER), JSON.stringify(marker, null, 2));
  const old = `${tmp}-old`;
  if (fs.existsSync(dest)) fs.renameSync(dest, old);
  fs.renameSync(tmp, dest);
  fs.rmSync(old, { recursive: true, force: true });
}

// Bring every target folder in line with the manifest. Never touches folders skillnet did not create,
// and never overwrites or deletes a synced folder that was edited locally.
export async function sync({ quiet = false } = {}) {
  const c = conf();
  const { skills } = await api('GET', '/api/manifest');
  const bundles = new Map();
  const want = new Map();
  for (const s of skills) if (!want.has(s.name)) want.set(s.name, s); // shortcut: two skills with one name, first wins; add owner-prefixed folders if that bites
  let changed = 0;
  const notes = [];
  for (const t of targets(c)) {
    for (const [name, s] of want) {
      const dest = path.join(t, name), mk = readJson(path.join(dest, MARKER), null);
      if (fs.existsSync(dest) && !mk) { notes.push(`kept your own folder ${dest} (not from skillnet)`); continue; }
      if (mk && mk.hash === s.hash) continue;
      if (mk && bundleHash(readFolder(dest)) !== mk.hash) { notes.push(`${dest} has local edits; not updating it (skillnet push it, or delete it)`); continue; }
      if (!bundles.has(s.id)) bundles.set(s.id, await api('GET', `/api/skills/${s.id}/bundle`));
      const b = bundles.get(s.id);
      writeFolder(dest, b.files, { id: s.id, owner: s.owner, name, hash: b.hash, version: b.version, server: c.server, source: !!mk?.source });
      changed++;
      if (!quiet) log(`${mk ? 'updated' : 'added'} ${s.owner}/${name} v${b.version} in ${t}`);
    }
    for (const e of fs.readdirSync(t)) {
      const dest = path.join(t, e), mk = readJson(path.join(dest, MARKER), null);
      if (!mk || mk.server !== c.server || want.get(e)?.id === mk.id) continue;
      if (mk.source) { fs.rmSync(path.join(dest, MARKER)); continue; } // the folder you published from stays yours
      if (bundleHash(readFolder(dest)) !== mk.hash) { notes.push(`${dest} has local edits; left it in place`); continue; }
      fs.rmSync(dest, { recursive: true, force: true });
      changed++;
      if (!quiet) log(`removed ${mk.owner}/${e} from ${t}`);
    }
  }
  if (changed) { fs.mkdirSync(CONF_DIR, { recursive: true }); fs.writeFileSync(CHANGED, String(Date.now())); }
  for (const n of new Set(notes)) if (!quiet) log(`note: ${n}`);
  return { changed, skills: skills.length };
}

// Live updates: hold a server-sent-events stream open and sync whenever the server says something changed.
async function watch() {
  let delay = 2000, timer = null;
  const run = () => { clearTimeout(timer); timer = setTimeout(() => sync().catch((e) => log(`sync failed: ${e.message}`)), 300); };
  setInterval(run, 15 * 60e3); // safety net if a push is missed
  for (;;) {
    const c = conf();
    try {
      const res = await fetch(`${c.server}/api/events`, { headers: { Authorization: `Bearer ${c.token}` } });
      if (res.status === 401) die('this device was signed out; run: skillnet setup');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log(`connected to ${c.server}`);
      delay = 2000;
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/^event: (sync|hello)$/m.test(ev)) run();
        }
      }
      throw new Error('stream closed');
    } catch (e) {
      log(`disconnected (${e.message}); retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60e3);
    }
  }
}

async function login(server) {
  const c = conf();
  server = (server || c.server || '').replace(/\/+$/, '');
  if (!server) die('usage: skillnet login <server-url>');
  const label = `${os.userInfo().username}@${os.hostname()}`;
  const d = await api('POST', '/api/device/start', { label }, { server });
  log(`\nApprove this device at:\n  ${d.verify_url}\nCode: ${d.user_code}\n`);
  try { execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [d.verify_url], { stdio: 'ignore' }); } catch {}
  for (;;) {
    await new Promise((r) => setTimeout(r, d.interval * 1000));
    try {
      const { token } = await api('POST', '/api/device/poll', { device_code: d.device_code }, { server });
      saveConf({ ...c, server, token });
      const me = await api('GET', '/api/me');
      return log(`signed in as @${me.user.handle}`);
    } catch (e) { if (e.status !== 428) die(e.message); }
  }
}

async function push(dir, flags) {
  dir = path.resolve(dir || '.');
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) die(`${dir} has no SKILL.md`);
  const files = readFolder(dir);
  const body = { files, name: flags.name || undefined, org: flags.org, visibility: flags.visibility, note: flags.note };
  if (flags.required) body.required = true;
  if (flags.optional) body.required = false;
  if (!body.name && !/^---[\s\S]*?\nname:/m.test(Buffer.from(files['SKILL.md'], 'base64').toString())) body.name = path.basename(dir).toLowerCase();
  const out = await api('POST', '/api/skills/push', body);
  const s = out.skill;
  // Mark the folder as the published copy so sync treats it as yours and never deletes it.
  const mk = readJson(path.join(dir, MARKER), {});
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ ...mk, id: s.id, owner: s.owner, name: s.name, hash: s.hash, version: s.version, server: conf().server, source: mk.source ?? !mk.id }, null, 2));
  log(`${out.changed ? 'published' : 'no changes to'} ${s.owner}/${s.name} v${s.version} (${s.visibility}${s.required ? ', required' : ''})`);
}

const findSkill = async (ref) => (await api('GET', `/api/resolve?ref=${encodeURIComponent(ref)}`)).skill;
// Plain-text answers come from the same tools agents use over MCP, so the command and MCP say the same thing.
async function tool(name, args = {}) {
  const r = await api('POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (r.error) die(r.error.message);
  if (r.result.isError) die(r.result.content[0].text);
  return r.result.content[0].text;
}
async function suggest(dir, flags) {
  dir = path.resolve(dir || '.');
  if (!flags.to) die('usage: skillnet suggest <dir> --to owner/name --note "why"');
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) die(`${dir} has no SKILL.md`);
  const s = await findSkill(flags.to);
  const r = await api('POST', `/api/skills/${s.id}/proposals`, { files: readFolder(dir), note: flags.note });
  log(`suggested change ${r.proposal.id} sent to the editors of ${r.proposal.skill}`);
}
// Chat: conversations are named by @handle (direct), group name, or id.
const findConvo = async (ref) => (await api('GET', `/api/convos/resolve?ref=${encodeURIComponent(ref)}`)).convo;
// Wait for the next message someone else sends (to this agent's account), print it, and exit: lets an agent block on a reply.
async function listen(ref, flags) {
  const c = conf(), only = ref && (await findConvo(ref)).id, me = (await api('GET', '/api/me')).user.id;
  const ctl = new AbortController(), secs = Number(flags.timeout || 0);
  if (secs) setTimeout(() => ctl.abort(), secs * 1000);
  let found = null;
  try {
    const res = await fetch(`${c.server}/api/events`, { headers: { Authorization: `Bearer ${c.token}` }, signal: ctl.signal });
    let buf = '';
    read: for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!/^event: message$/m.test(ev)) continue;
        const d = JSON.parse(/^data: (.*)$/m.exec(ev)[1]);
        if (d.message.from.id === me || (only && d.convo !== only)) continue;
        found = d;
        break read;
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  ctl.abort();
  return found;
}
const userByHandle = (list, handle) => list.find((u) => u.handle === handle.replace(/^@/, '')) || die(`@${handle} is not in that list`);

// Run `skillnet watch` at login: launchd on macOS, a systemd user unit on Linux.
function serviceInstall() {
  const node = process.execPath, me = fs.realpathSync(fileURLToPath(import.meta.url));
  const logf = path.join(CONF_DIR, 'watch.log');
  fs.mkdirSync(CONF_DIR, { recursive: true });
  if (process.platform === 'darwin') {
    const plist = path.join(HOME, 'Library/LaunchAgents/com.skillnet.watch.plist');
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.skillnet.watch</string>
<key>ProgramArguments</key><array><string>${node}</string><string>${me}</string><string>watch</string></array>
<key>EnvironmentVariables</key><dict><key>SKILLNET_HOME</key><string>${CONF_DIR}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${logf}</string><key>StandardErrorPath</key><string>${logf}</string>
</dict></plist>\n`);
    const uid = process.getuid();
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/com.skillnet.watch`], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist]);
  } else {
    const unit = path.join(HOME, '.config/systemd/user/skillnet.service');
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Unit]\nDescription=skillnet sync\n\n[Service]\nEnvironment=SKILLNET_HOME=${CONF_DIR}\nExecStart=${node} ${me} watch\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`);
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', 'skillnet.service']);
    execFileSync('systemctl', ['--user', 'restart', 'skillnet.service']);
  }
  log(`background sync is on (log: ${logf})`);
}

function piExtension() {
  const dir = path.join(HOME, '.pi/agent/extensions');
  if (!fs.existsSync(path.join(HOME, '.pi/agent'))) return;
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), 'pi-skillnet-reload.ts');
  if (!fs.existsSync(src)) return log('note: pi extension file missing next to skillnet.js; Pi users run /reload by hand');
  fs.copyFileSync(src, path.join(dir, 'skillnet-reload.ts'));
  log('Pi extension installed: Pi reloads skills by itself when they change (new Pi sessions pick it up)');
}

const BOOL = new Set(['required', 'optional', 'json', 'write', 'yes', 'new']);
function parseFlags(args) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? (BOOL.has(k) ? true : args[++i]);
  }
  return { flags, rest };
}

const HELP = `skillnet — share agent skills with friends and organizations (add --json for data)

Questions
  whoami                         account, organizations, roles, friends
  search [words]                 skills you can see
  show owner/name [file]         print SKILL.md or another file
  info owner/name                owner, who can edit, versions, open suggestions
  list                           skills this machine gets
  suggestions [owner/name]       suggested changes waiting for review

Changes
  push [dir] [--org ID] [--visibility private|friends|org|public] [--required|--optional] [--note TEXT]
  suggest [dir] --to owner/name [--note TEXT]    propose a change to a skill you cannot edit
  approve ID | decline ID        review a suggestion (editors)
  install owner/name | remove owner/name         add or drop it on all your machines
  require owner/name | optional owner/name       organization admins: everyone gets it, or only who adds it
  visibility owner/name private|friends|org|public
  rollback owner/name VERSION
  delete owner/name --yes

Chat (people and their agents; the agent sends within what its owner allows)
  chats                          conversations, who is in them, unread
  read CONVO                     recent messages (CONVO is @handle, a group name, or an id)
  say CONVO TEXT [--kind chat|question|task|personal] [--skill owner/name]
  listen [CONVO] [--timeout SECS]  wait for the next message, print it, exit
  chat new NAME [@friend ...] | chat with @friend | chat join LINK
  chat invite CONVO | chat agent CONVO on|off
  perms [CONVO] | perms [CONVO] set out|in KIND allow|ask|never

People
  friends | friend add WHO | friend remove HANDLE
  orgs | org create ID [NAME] | org show ID | org invite ID [--new] | join CODE-OR-LINK
  org role ID HANDLE owner|admin|editor|member | org remove ID HANDLE

Machines and keys
  setup <server>                 sign in, background sync, Pi reload extension
  login <server> [--key KEY]     sign in only (a key skips the browser step)
  keys | key create LABEL [--write] | key revoke ID
  sync | watch | targets
  Cloud runs: set SKILLNET_KEY (and SKILLNET_URL) instead of signing in.`;

const out = (flags, data, text) => log(flags.json ? JSON.stringify(data, null, 2) : typeof text === 'function' ? text(data) : text);
const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { flags, rest } = parseFlags(args);
  const ref = () => rest[0] || die(`usage: skillnet ${cmd} owner/name`);
  const need = (i, what) => rest[i] || die(`usage: skillnet ${cmd} ${what}`);
  const sub = rest.shift();
  if (!['friend', 'org', 'key', 'chat'].includes(cmd) && sub !== undefined) rest.unshift(sub);
  switch (cmd) {
    case 'setup': await login(rest[0]); piExtension(); await sync(); serviceInstall(); break;
    case 'login':
      if (flags.key) { const server = (rest[0] || conf().server || die('usage: skillnet login <server> --key KEY')).replace(/\/+$/, ''); saveConf({ ...readJson(CONF, {}), server, token: flags.key }); log(`signed in as @${(await api('GET', '/api/me')).user.handle}`); }
      else await login(rest[0]);
      break;
    case 'whoami': flags.json ? out(flags, await api('GET', '/api/me')) : log(await tool('my_account')); break;
    case 'search': {
      const q = rest.join(' ');
      flags.json ? out(flags, (await api('GET', `/api/skills?q=${encodeURIComponent(q)}`)).skills) : log(await tool('search_skills', { query: q }));
      break;
    }
    case 'show': { const s = await findSkill(ref()); const f = await api('GET', `/api/skills/${s.id}/file?path=${encodeURIComponent(rest[1] || 'SKILL.md')}`); out(flags, f, f.text); break; }
    case 'info': flags.json ? out(flags, await api('GET', `/api/skills/${(await findSkill(ref())).id}`)) : log(await tool('skill_info', { skill: ref() })); break;
    case 'list': { const { skills } = await api('GET', '/api/manifest'); out(flags, skills, () => skills.map((s) => `${s.owner}/${s.name} v${s.version}${s.required ? ' (required)' : ''}`).join('\n')); break; }
    case 'suggestions': {
      const s = rest[0] && await findSkill(rest[0]);
      const { proposals } = await api('GET', `/api/proposals${s ? `?skill=${s.id}` : ''}`);
      out(flags, proposals, () => proposals.map((p) => `${p.id}  ${p.skill}  by @${p.author} on v${p.base_version}${p.base_version !== p.current_version ? ` (now v${p.current_version})` : ''}: ${p.note || '(no note)'}`).join('\n') || 'No suggestions waiting.');
      break;
    }
    case 'push': await push(rest[0], flags); break;
    case 'suggest': await suggest(rest[0], flags); break;
    case 'approve': { const r = await api('POST', `/api/proposals/${need(0, 'ID')}/approve`); log(`approved: ${r.skill.owner}/${r.skill.name} is now v${r.skill.version}`); break; }
    case 'decline': await api('POST', `/api/proposals/${need(0, 'ID')}/decline`); log('declined'); break;
    case 'install': { const s = await findSkill(ref()); await api('POST', `/api/skills/${s.id}/install`); await sync(); break; }
    case 'remove': { const s = await findSkill(ref()); await api('DELETE', `/api/skills/${s.id}/install`); await sync(); break; }
    case 'require': case 'optional': { const s = await findSkill(ref()); await api('PATCH', `/api/skills/${s.id}`, { required: cmd === 'require' }); log(`${s.owner}/${s.name} is now ${cmd === 'require' ? 'required for every member' : 'optional'}`); break; }
    case 'visibility': { const s = await findSkill(ref()); await api('PATCH', `/api/skills/${s.id}`, { visibility: need(1, 'owner/name private|friends|org|public') }); log(`${s.owner}/${s.name} visibility: ${rest[1]}`); break; }
    case 'rollback': { const s = await findSkill(ref()); const r = await api('POST', `/api/skills/${s.id}/rollback`, { version: Number(need(1, 'owner/name VERSION')) }); log(`${s.owner}/${s.name} is back to version ${rest[1]} (saved as v${r.skill.version})`); break; }
    case 'delete': { if (!flags.yes) die('this removes it from every machine; add --yes to confirm'); const s = await findSkill(ref()); await api('DELETE', `/api/skills/${s.id}`); log(`deleted ${s.owner}/${s.name}`); break; }
    case 'friends': { const f = await api('GET', '/api/friends'); out(flags, f, () => [`Friends: ${f.friends.map((u) => `@${u.handle}`).join(', ') || 'none'}`, f.incoming.length && `Asking you: ${f.incoming.map((u) => `@${u.handle}`).join(', ')} (accept with: skillnet friend add HANDLE)`, f.outgoing.length && `Waiting for: ${f.outgoing.map((u) => `@${u.handle}`).join(', ')}`].filter(Boolean).join('\n')); break; }
    case 'friend':
      if (sub === 'add') { const r = await api('POST', '/api/friends', { who: need(0, 'add WHO') }); log(r.status === 'accepted' ? `you and @${r.user.handle} are friends` : `request sent to @${r.user.handle}`); }
      else if (sub === 'remove') { const f = await api('GET', '/api/friends'); const u = userByHandle([...f.friends, ...f.incoming, ...f.outgoing], need(0, 'remove HANDLE')); await api('DELETE', `/api/friends/${u.id}`); log(`removed @${u.handle}`); }
      else die('usage: skillnet friend add|remove WHO');
      break;
    case 'orgs': { const { orgs } = await api('GET', '/api/me'); out(flags, orgs, () => orgs.map((o) => `${o.slug}  ${o.name} (${o.role})`).join('\n') || 'No organizations.'); break; }
    case 'org': {
      const id = need(0, `${sub || 'show'} ID`);
      if (sub === 'create') { const r = await api('POST', '/api/orgs', { slug: id, name: rest.slice(1).join(' ') || id }); log(`created ${r.org.slug}; invite people with: skillnet org invite ${r.org.slug}`); }
      else if (sub === 'show') { const d = await api('GET', `/api/orgs/${id}`); out(flags, d, () => [`${d.org.name} (${d.org.slug}), you are ${d.org.role}`, 'Members:', ...d.members.map((m) => `  @${m.handle} ${m.role}`), 'Skills:', ...d.skills.map((s) => `  ${s.name} v${s.version}${s.required ? ' required' : ''}`)].join('\n')); }
      else if (sub === 'invite') { const link = flags.new ? (await api('POST', `/api/orgs/${id}/invite`)).invite : (await api('GET', `/api/orgs/${id}`)).org.invite; log(link || die('only admins see the invite link')); }
      else if (sub === 'role' || sub === 'remove') {
        const d = await api('GET', `/api/orgs/${id}`), m = userByHandle(d.members, need(1, `${sub} ID HANDLE`));
        if (sub === 'role') { await api('POST', `/api/orgs/${id}/members/${m.id}`, { role: need(2, 'role ID HANDLE owner|admin|editor|member') }); log(`@${m.handle} is now ${rest[2]} in ${id}`); }
        else { await api('DELETE', `/api/orgs/${id}/members/${m.id}`); log(`removed @${m.handle} from ${id}`); }
      } else die('usage: skillnet org create|show|invite|role|remove ID ...');
      break;
    }
    case 'join': { const code = need(0, 'CODE-OR-LINK'); const r = await api('POST', '/api/join', { code: /code=([\w-]+)/.exec(code)?.[1] || code }); log(`you joined ${r.org.name}`); await sync(); break; }
    case 'chats': {
      const { convos } = await api('GET', '/api/convos');
      out(flags, convos, () => convos.map((c) => `${c.id}  ${c.kind === 'dm' ? `@${c.members.find((x) => x.name === c.name || x.handle === c.name)?.handle || c.name}` : `"${c.name}"`}  ${c.members.length} people${c.my_agent ? ', your agent is in' : ''}${c.unread ? `, ${c.unread} unread` : ''}${c.waiting ? `, ${c.waiting} waiting for your approval` : ''}`).join('\n') || 'No conversations. Start one: skillnet chat with @friend');
      break;
    }
    case 'read': flags.json ? out(flags, await api('GET', `/api/convos/${(await findConvo(ref())).id}`)) : log(await tool('read_conversation', { conversation: ref() })); break;
    case 'say': {
      const c = await findConvo(need(0, 'CONVO TEXT'));
      const r = await api('POST', `/api/convos/${c.id}/messages`, { text: rest.slice(1).join(' '), kind: flags.skill ? 'skill' : flags.kind || 'chat', skill: flags.skill });
      out(flags, r, r.message.status === 'held' ? 'held: your owner approves this kind of message first (on the website)' : 'sent');
      break;
    }
    case 'listen': { const d = await listen(rest[0], flags); if (!d) die('no message before the timeout'); out(flags, d, () => `${d.convo}  ${d.message.agent ? `@${d.message.from.handle}'s agent` : `@${d.message.from.handle}`}${d.message.kind === 'chat' ? '' : ` (${d.message.kind})`}: ${d.message.kind === 'skill' ? `shared ${d.message.data.skill.ref}` : d.message.text}`); break; }
    case 'chat': {
      if (sub === 'new') { const r = await api('POST', '/api/convos', { name: need(0, 'new NAME [@friend ...]'), people: rest.slice(1) }); log(`started "${r.convo.name}" (${r.convo.id}). Invite link: ${r.convo.invite}`); }
      else if (sub === 'with') { const r = await api('POST', '/api/convos', { with: need(0, 'with @friend') }); log(`${r.convo.id}  with ${r.convo.name}`); }
      else if (sub === 'join') { const r = await api('POST', '/api/convos/join', { code: need(0, 'join LINK') }); log(`joined "${r.convo.name}"`); }
      else if (sub === 'invite') log((await findConvo(need(0, 'invite CONVO'))).invite || die('direct chats have no invite link'));
      else if (sub === 'agent') { const c = await findConvo(need(0, 'agent CONVO on|off')); await api('PATCH', `/api/convos/${c.id}`, { agent: need(1, 'agent CONVO on|off') === 'on' }); log(`your agent is ${rest[1]} in ${c.name}`); }
      else die('usage: skillnet chat new|with|join|invite|agent ...');
      break;
    }
    case 'perms': {
      const c = rest[0] && rest[0] !== 'set' ? await findConvo(rest.shift()) : null;
      if (rest[0] === 'set') await api('PUT', '/api/permissions', { convo: c?.id, [need(1, 'set out|in KIND MODE')]: { [need(2, 'set out|in KIND MODE')]: need(3, 'set out|in KIND MODE') } });
      const p = await api('GET', `/api/permissions${c ? `?convo=${c.id}` : ''}`);
      out(flags, p, () => [`${c ? c.name : 'Defaults for every conversation'}`, ...Object.entries(p.kinds).map(([k, label]) => `  ${k.padEnd(9)} send: ${p.permissions.out[k].padEnd(5)}  shown: ${p.permissions.in[k].padEnd(5)}  ${label}`)].join('\n'));
      break;
    }
    case 'keys': { const { tokens } = await api('GET', '/api/tokens'); out(flags, tokens, () => tokens.map((t) => `${t.id}  ${t.kind === 'key' ? `key (${t.scope})` : 'machine'}  ${t.label}  last used ${when(t.used)}`).join('\n') || 'None.'); break; }
    case 'key':
      if (sub === 'create') { const r = await api('POST', '/api/keys', { label: rest.join(' ') || die('usage: skillnet key create LABEL [--write]'), scope: flags.write ? 'write' : 'read' }); out(flags, r, `${r.key}\n(${r.scope} key "${r.label}"; shown once. Set it as SKILLNET_KEY in the cloud run's secrets.)`); }
      else if (sub === 'revoke') { await api('DELETE', `/api/tokens/${need(0, 'revoke ID')}`); log('revoked'); }
      else die('usage: skillnet key create|revoke ...');
      break;
    case 'sync': { const r = await sync(); log(`${r.skills} skills, ${r.changed} changes`); break; }
    case 'watch': await watch(); break;
    case 'targets': for (const t of targets()) log(t); break;
    case 'service': serviceInstall(); break;
    default: log(HELP);
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main().catch((e) => die(e.message));
