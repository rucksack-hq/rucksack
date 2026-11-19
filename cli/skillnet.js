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
const conf = () => readJson(CONF, {});
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

async function findSkill(ref) {
  const [owner, name] = ref.includes('/') ? ref.split('/') : [null, ref];
  const { skills } = await api('GET', `/api/skills?q=${encodeURIComponent(name)}`);
  const hits = skills.filter((s) => s.id === ref || (s.name === name && (!owner || s.owner === owner)));
  if (hits.length !== 1) die(hits.length ? `several skills are named ${name}; use owner/name` : `no skill ${ref}`);
  return hits[0];
}

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

function parseFlags(args) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? (['required', 'optional'].includes(k) ? true : args[++i]);
  }
  return { flags, rest };
}

const HELP = `skillnet — share agent skills with friends and organizations

  skillnet setup <server>        sign in, turn on background sync, add the Pi reload extension
  skillnet login <server>        sign in only
  skillnet push [dir] [--org ID] [--visibility private|friends|org|public] [--required|--optional] [--note TEXT]
  skillnet install owner/name    add someone's skill to all your machines
  skillnet remove owner/name     take it off again
  skillnet list                  skills this machine should have
  skillnet sync                  sync now
  skillnet watch                 stay connected and sync on every change (what the background service runs)
  skillnet targets               folders skillnet writes to (set "targets" in ${CONF} to change)`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { flags, rest } = parseFlags(args);
  switch (cmd) {
    case 'setup': await login(rest[0]); piExtension(); await sync(); serviceInstall(); break;
    case 'login': await login(rest[0]); break;
    case 'push': await push(rest[0], flags); break;
    case 'install': { const s = await findSkill(rest[0] || die('usage: skillnet install owner/name')); await api('POST', `/api/skills/${s.id}/install`); await sync(); break; }
    case 'remove': { const s = await findSkill(rest[0] || die('usage: skillnet remove owner/name')); await api('DELETE', `/api/skills/${s.id}/install`); await sync(); break; }
    case 'list': for (const s of (await api('GET', '/api/manifest')).skills) log(`${s.owner}/${s.name} v${s.version}${s.required ? ' (required by organization)' : ''}`); break;
    case 'sync': { const r = await sync(); log(`${r.skills} skills, ${r.changed} changes`); break; }
    case 'watch': await watch(); break;
    case 'targets': for (const t of targets()) log(t); break;
    case 'service': serviceInstall(); break;
    default: log(HELP);
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main().catch((e) => die(e.message));
