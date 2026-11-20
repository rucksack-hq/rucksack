// Rucksack server: accounts, friends, organizations, skills with versions, live push to sync clients.
// Zero dependencies: node:http + node:sqlite (Node 22.5+).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitMirror } from './git.js';
import { buildPluginRepo, servePlugin } from './plugin.js';
import { accessApi, ACCESS_SCHEMA } from './access.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const MAX_BUNDLE = 5 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VIS_USER = ['private', 'friends', 'public'];
const VIS_ORG = ['org', 'public'];
const ROLES = ['owner', 'admin', 'editor', 'member'];
// What an agent may say in a chat, each kind gated by its owner: out = allow (send), ask (hold for the owner), never; in = allow, never.
const KIND_LABELS = { chat: 'Talk and answer', question: 'Ask questions', task: 'Ask for work to be done', skill: 'Share skills', personal: 'Share details about me (calendar, contacts, files, places)' };
const KINDS = Object.keys(KIND_LABELS);
const DEFAULT_GRANTS = {
  out: { chat: 'ask', question: 'ask', task: 'ask', skill: 'allow', personal: 'never' },
  in: { chat: 'allow', question: 'allow', task: 'never', skill: 'allow', personal: 'allow' },
};
const AGENT_RUN = 12; // agent messages in a row, with no person speaking, before agents must wait
// The skill every account gets: teaches agents to answer Rucksack questions from the harness.
const GUIDE_ID = 'skillnet-guide';
const guideFiles = (baseUrl) => ({ 'SKILL.md': Buffer.from(fs.readFileSync(path.join(HERE, 'builtin', 'skillnet', 'SKILL.md'), 'utf8').replaceAll('{{URL}}', baseUrl)).toString('base64') });

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, handle TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, pw TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
      kind TEXT NOT NULL, label TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER);
    CREATE TABLE IF NOT EXISTS devices(device_code TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
      user_id TEXT, token TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS friends(a TEXT NOT NULL REFERENCES users ON DELETE CASCADE, b TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
      status TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(a,b));
    CREATE TABLE IF NOT EXISTS orgs(id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, invite TEXT UNIQUE NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS members(org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
      role TEXT NOT NULL, PRIMARY KEY(org_id,user_id));
    CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY, owner_user TEXT REFERENCES users ON DELETE CASCADE, owner_org TEXT REFERENCES orgs ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0, hash TEXT, updated INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS skills_owner_name ON skills(coalesce(owner_user, owner_org), name);
    CREATE TABLE IF NOT EXISTS versions(skill_id TEXT NOT NULL REFERENCES skills ON DELETE CASCADE, version INTEGER NOT NULL, hash TEXT NOT NULL,
      bundle TEXT NOT NULL, author TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, PRIMARY KEY(skill_id,version));
    CREATE TABLE IF NOT EXISTS installs(user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, skill_id TEXT NOT NULL REFERENCES skills ON DELETE CASCADE,
      PRIMARY KEY(user_id,skill_id));
    CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, base_version INTEGER NOT NULL, bundle TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_codes(hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scope TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS convos(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', invite TEXT UNIQUE,
      agents TEXT NOT NULL DEFAULT '{}', created_by TEXT, created INTEGER NOT NULL, last INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS convo_members(convo_id TEXT NOT NULL REFERENCES convos ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member', read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(convo_id,user_id));
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, convo_id TEXT NOT NULL REFERENCES convos ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, agent TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT,
      status TEXT NOT NULL DEFAULT 'sent', hold TEXT, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_convo ON messages(convo_id, created);
    CREATE TABLE IF NOT EXISTS grants(owner TEXT NOT NULL REFERENCES users ON DELETE CASCADE, other TEXT NOT NULL, dir TEXT NOT NULL,
      kind TEXT NOT NULL, mode TEXT NOT NULL, PRIMARY KEY(owner,other,dir,kind));
    CREATE TABLE IF NOT EXISTS approvals(proposal_id TEXT NOT NULL REFERENCES proposals ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
      created INTEGER NOT NULL, PRIMARY KEY(proposal_id,user_id));
  `);
  // Columns added after the first release.
  for (const sql of [`ALTER TABLE tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'write'`, `ALTER TABLE skills ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
    // Connector sign-ins (OAuth): a 'connector' row is the long-lived grant holding the refresh token; its short 'oauth' access tokens point at it.
    `ALTER TABLE tokens ADD COLUMN expires INTEGER`, `ALTER TABLE tokens ADD COLUMN grant_id TEXT`, `ALTER TABLE tokens ADD COLUMN client TEXT`,
    // Billing: 'free' or 'team'; the Stripe customer and subscription of a paid organization.
    `ALTER TABLE orgs ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`, `ALTER TABLE orgs ADD COLUMN stripe_customer TEXT`, `ALTER TABLE orgs ADD COLUMN stripe_sub TEXT`,
    // Reviews: how many approvals a change to an organization skill needs (0 = editors publish directly). Change requests remember
    // the files they started from (for a three-way merge), and the git branch and commit they came from.
    `ALTER TABLE orgs ADD COLUMN review INTEGER NOT NULL DEFAULT 0`, `ALTER TABLE proposals ADD COLUMN base_bundle TEXT`,
    `ALTER TABLE proposals ADD COLUMN branch TEXT`, `ALTER TABLE proposals ADD COLUMN commit_sha TEXT`])
    try { db.exec(sql); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  db.exec(ACCESS_SCHEMA);
  return db;
}

const now = () => Date.now();
const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw) => { const salt = rid(16); return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPw = (pw, stored) => {
  const [salt, h] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 32));
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

// Files in a bundle: {"SKILL.md": "<base64>", "scripts/x.sh": "<base64>"}. Paths must stay inside the skill folder.
export function checkFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) fail(400, 'files must be an object');
  const names = Object.keys(files);
  if (!names.includes('SKILL.md')) fail(400, 'a skill needs a SKILL.md at its top level');
  if (names.length > 500) fail(400, 'too many files (500 max)');
  for (const p of names) {
    const parts = p.split('/');
    if (p.startsWith('/') || p.includes('\\') || parts.some((x) => x === '' || x === '.' || x === '..') || p === '.skillnet.json')
      fail(400, `bad file path: ${p}`);
    if (typeof files[p] !== 'string') fail(400, `file ${p} must be base64 text`);
  }
}
// Three-way merge by file: a file both sides changed differently is a conflict.
export function merge3(base, mine, cur) {
  const files = {}, conflicts = [];
  for (const p of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(cur)])) {
    const b = base[p], m = mine[p], c = cur[p];
    const v = m === c ? m : m === b ? c : c === b ? m : (conflicts.push(p), m);
    if (v !== undefined) files[p] = v;
  }
  return { files, conflicts };
}
export const bundleHash = (files) => sha(Object.keys(files).sort().map((p) => `${p}\0${files[p]}`).join('\0'));

export function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

export const FREE_SEATS = 3; // people an organization may have before it needs the Team plan

// Stripe over plain fetch. Nested params use Stripe's bracket form: {line_items: [{price: 'p'}]} -> line_items[0][price]=p.
function stripeForm(obj, pre = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = pre ? `${pre}[${k}]` : k;
    if (v && typeof v === 'object') stripeForm(v, key, out); else if (v !== undefined) out.append(key, String(v));
  }
  return out;
}
export function stripeClient(key, api = 'https://api.stripe.com/v1') {
  return async (method, p, params) => {
    const res = await fetch(`${api}${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params ? stripeForm(params) : undefined });
    const out = await res.json();
    if (!res.ok) throw new HttpError(502, `billing: ${out.error?.message || res.status}`);
    return out;
  };
}
// Stripe-Signature: t=<time>,v1=<hmac of "t.body">. Rejects anything older than 5 minutes.
export function stripeVerify(raw, header, secret, at = Date.now()) {
  const parts = Object.fromEntries(String(header || '').split(',').map((x) => x.split('=')));
  const sigs = String(header || '').split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
  if (!parts.t || !sigs.length || Math.abs(at / 1000 - Number(parts.t)) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  return sigs.some((g) => g.length === want.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(want)));
}

export function createApp({ db, baseUrl = '', billing = null, redirectHosts = [], gitDir = null, secretKey = null, allowPrivate = false }) {
  // billing: { stripe: (method, path, params) => Promise, price, webhookSecret, priceLabel } or null when Stripe is not set up.
  const all = (sql, p = {}) => db.prepare(sql).all(p);
  const one = (sql, p = {}) => db.prepare(sql).get(p);
  const run = (sql, p = {}) => db.prepare(sql).run(p);

  // Live push: every connected sync client of a user gets "sync" and re-reads its manifest.
  const streams = new Map(); // user_id -> Set(res); res.human is true for website sessions, false for agents
  // MCP streams (res.mcp) only hear that the skill list changed, as an MCP notification, so the app refetches it mid-session.
  const emit = (userIds, event, data = () => ({}), only = () => true) => {
    for (const u of new Set(userIds)) for (const res of streams.get(u) || []) {
      if (res.mcp) { if (event === 'sync') res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' })}\n\n`); }
      else if (only(res, u)) res.write(`event: ${event}\ndata: ${JSON.stringify(data(u, res))}\n\n`);
    }
  };
  const notify = (userIds) => emit(userIds, 'sync');
  // Everyone who might see or have this skill: owner, owner's friends, org members, installers. Public skills reach installers only.
  const audience = (s) => [
    ...(s.owner_user ? [s.owner_user, ...friendIds(s.owner_user)] : []),
    ...(s.owner_org ? all('SELECT user_id FROM members WHERE org_id=:o', { o: s.owner_org }).map((r) => r.user_id) : []),
    ...all('SELECT user_id FROM installs WHERE skill_id=:s', { s: s.id }).map((r) => r.user_id),
  ];
  const friendIds = (u) => all(`SELECT CASE WHEN a=:u THEN b ELSE a END id FROM friends WHERE status='accepted' AND (a=:u OR b=:u)`, { u }).map((r) => r.id);

  const VISIBLE = `(s.visibility='public' OR s.owner_user=:u
    OR (s.owner_org IS NOT NULL AND s.owner_org IN (SELECT org_id FROM members WHERE user_id=:u))
    OR (s.visibility='friends' AND s.owner_user IN (SELECT CASE WHEN a=:u THEN b ELSE a END FROM friends WHERE status='accepted' AND (a=:u OR b=:u))))`;
  const SKILL_COLS = `s.*, coalesce(u.handle, o.slug) owner, CASE WHEN s.owner_org IS NULL THEN 'user' ELSE 'org' END owner_kind`;
  const SKILL_FROM = `skills s LEFT JOIN users u ON u.id=s.owner_user LEFT JOIN orgs o ON o.id=s.owner_org`;

  const role = (orgId, u) => one('SELECT role FROM members WHERE org_id=:o AND user_id=:u', { o: orgId, u })?.role;
  const isAdmin = (orgId, u) => ['owner', 'admin'].includes(role(orgId, u));
  const isEditor = (orgId, u) => ['owner', 'admin', 'editor'].includes(role(orgId, u));
  // Editors change what a skill says; admins also decide who gets it (visibility, required, delete).
  const canEdit = (s, u) => (s.owner_user ? s.owner_user === u : isEditor(s.owner_org, u));
  const canManage = (s, u) => (s.owner_user ? s.owner_user === u : isAdmin(s.owner_org, u));
  const getOrg = (slug) => one('SELECT * FROM orgs WHERE slug=:slug', { slug }) || fail(404, 'no such organization');
  const visibleSkill = (id, u) =>
    one(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE s.id=:id AND ${VISIBLE}`, { id, u }) || fail(404, 'no such skill');
  const pubSkill = (s, u) => ({
    id: s.id, owner: s.owner, owner_kind: s.owner_kind, name: s.name, description: s.description, visibility: s.visibility,
    required: !!s.required, version: s.version, hash: s.hash, updated: s.updated, can_edit: canEdit(s, u), can_manage: canManage(s, u),
    installed: !!one('SELECT 1 x FROM installs WHERE user_id=:u AND skill_id=:s', { u, s: s.id }),
    open_proposals: canEdit(s, u) ? one(`SELECT count(*) n FROM proposals WHERE skill_id=:s AND status='open'`, { s: s.id }).n : 0,
  });
  const userOut = (r) => r && { id: r.id, handle: r.handle, name: r.name };

  function issueToken(userId, kind, label, scope = 'write') {
    const token = `sn_${rid(32)}`;
    run('INSERT INTO tokens(id,hash,user_id,kind,label,created,scope) VALUES(:id,:h,:u,:k,:l,:c,:s)', { id: rid(8), h: sha(token), u: userId, k: kind, l: label, c: now(), s: scope });
    return token;
  }
  // bearerOnly: the MCP endpoint ignores the browser cookie, so other websites cannot call it as the signed-in person.
  function auth(req, bearerOnly = false) {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    const cookie = bearerOnly ? null : /(?:^|;\s*)sn=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const tok = bearer || cookie;
    if (!tok) return null;
    const row = one(`SELECT t.id tid, t.kind tkind, COALESCE(g.label, t.label) tlabel, t.scope, t.grant_id, u.* FROM tokens t JOIN users u ON u.id=t.user_id
      LEFT JOIN tokens g ON g.id=t.grant_id
      WHERE t.hash=:h AND t.kind!='connector' AND (t.expires IS NULL OR t.expires>:n)`, { h: sha(tok), n: now() });
    if (row) run('UPDATE tokens SET used=:n WHERE id IN (:id, :g)', { n: now(), id: row.tid, g: row.grant_id || row.tid });
    return row || null;
  }

  // Other parts (git mirror) listen for published and deleted skills.
  const hooks = { publish: [], remove: [] };
  const reviewsNeeded = (s) => (s.owner_org ? one('SELECT review FROM orgs WHERE id=:o', { o: s.owner_org }).review : 0);
  const versionFiles = (skillId, v) => JSON.parse(one('SELECT bundle FROM versions WHERE skill_id=:s AND version=:v', { s: skillId, v })?.bundle || '{}');
  // A change request. With a branch, a newer push to the same branch replaces it and its approvals start over.
  function propose(me, s, files, { note = '', branch = null, commit = null, baseFiles = null } = {}) {
    checkFiles(files);
    if (bundleHash(files) === s.hash) fail(400, 'that is the same as the current version');
    const base = JSON.stringify(baseFiles || versionFiles(s.id, s.version));
    const old = branch && one(`SELECT id FROM proposals WHERE skill_id=:s AND branch=:b AND status='open'`, { s: s.id, b: branch });
    const id = old?.id || rid(9);
    if (old) {
      run('UPDATE proposals SET bundle=:b, note=:n, base_bundle=:bb, base_version=:v, commit_sha=:c, user_id=:u, created=:t WHERE id=:id',
        { id, b: JSON.stringify(files), n: String(note).slice(0, 2000), bb: base, v: s.version, c: commit, u: me.id, t: now() });
      run('DELETE FROM approvals WHERE proposal_id=:id', { id });
    } else run(`INSERT INTO proposals(id,skill_id,user_id,base_version,bundle,note,created,base_bundle,branch,commit_sha) VALUES(:id,:s,:u,:v,:b,:n,:t,:bb,:br,:c)`,
      { id, s: s.id, u: me.id, v: s.version, b: JSON.stringify(files), n: String(note).slice(0, 2000), t: now(), bb: base, br: branch, c: commit });
    return { id, skill: `${s.owner}/${s.name}`, skill_id: s.id, status: 'open', needs: Math.max(reviewsNeeded(s), 1) };
  }

  // Publish files as a new version. `author` is who wrote the change (the proposer when an editor approves one).
  // opts.direct skips the organization's review rule (used when an approved change request is merged); opts.fromGit means the
  // files arrived in a git push to main, so the mirror must not write its own commit for them; opts.merge is that branch commit.
  function pushSkill(me, b, author = me.id, opts = {}) {
    checkFiles(b.files);
    const size = Object.values(b.files).reduce((n, v) => n + v.length, 0);
    if (size > MAX_BUNDLE) fail(413, 'skill is larger than 5 MB');
    const md = Buffer.from(b.files['SKILL.md'], 'base64').toString('utf8');
    const fm = frontmatter(md);
    const name = String(b.name || fm.name || '').toLowerCase();
    if (!NAME_RE.test(name)) fail(400, 'skill name must be lowercase letters, digits and dashes');
    const description = String(b.description ?? fm.description ?? '').slice(0, 1024);
    let org = null;
    if (b.org) { org = getOrg(b.org); if (!isEditor(org.id, me.id)) fail(403, `only editors and admins of ${org.slug} can change its skills; suggest a change instead`); }
    const allowed = org ? VIS_ORG : VIS_USER;
    let s = one('SELECT * FROM skills WHERE coalesce(owner_user, owner_org)=:o AND name=:n', { o: org ? org.id : me.id, n: name });
    const visibility = b.visibility ?? s?.visibility ?? allowed[0];
    if (!allowed.includes(visibility)) fail(400, `visibility must be one of ${allowed.join(', ')}`);
    const required = org ? (b.required === undefined ? !!s?.required : !!b.required) : false;
    if (org && !isAdmin(org.id, me.id) && (visibility !== (s?.visibility ?? 'org') || required !== !!s?.required))
      fail(403, 'only admins decide who gets an organization skill (visibility, required)');
    const body = md.slice(0, 100e3);
    const hash = bundleHash(b.files);
    if (org?.review > 0 && !opts.direct && hash !== s?.hash) {
      // Reviewed organization: the change waits for approval. A new skill starts as a draft (version 0) that nobody gets yet.
      if (!s) {
        const id = rid(9);
        run('INSERT INTO skills(id,owner_user,owner_org,name,description,visibility,required,updated) VALUES(:id,NULL,:oo,:n,:d,:v,:r,:t)',
          { id, oo: org.id, n: name, d: description, v: visibility, r: required ? 1 : 0, t: now() });
        run('INSERT OR IGNORE INTO installs VALUES(:u,:s)', { u: me.id, s: id });
      }
      s = one(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE coalesce(s.owner_user, s.owner_org)=:o AND s.name=:n`, { o: org.id, n: name });
      const proposal = propose(me, s, b.files, { note: b.note || '', branch: b.branch || null, commit: b.commit || null });
      return { skill: pubSkill(s, me.id), changed: false, proposal };
    }
    db.exec('BEGIN');
    try {
      if (!s) {
        const id = rid(9);
        run('INSERT INTO skills(id,owner_user,owner_org,name,description,visibility,required,updated) VALUES(:id,:ou,:oo,:n,:d,:v,:r,:t)',
          { id, ou: org ? null : me.id, oo: org ? org.id : null, n: name, d: description, v: visibility, r: required ? 1 : 0, t: now() });
        run('INSERT OR IGNORE INTO installs VALUES(:u,:s)', { u: me.id, s: id }); // authors get their skill on every machine
        s = one('SELECT * FROM skills WHERE id=:id', { id });
      }
      const changed = hash !== s.hash;
      if (changed) {
        const v = s.version + 1;
        run('INSERT INTO versions VALUES(:s,:v,:h,:b,:a,:note,:t)', { s: s.id, v, h: hash, b: JSON.stringify(b.files), a: author, note: String(b.note || ''), t: now() });
        run('UPDATE skills SET version=:v, hash=:h, updated=:t WHERE id=:s', { v, h: hash, t: now(), s: s.id });
      }
      run('UPDATE skills SET description=:d, visibility=:v, required=:r, body=:body WHERE id=:s',
        { d: description, v: visibility, r: required ? 1 : 0, body, s: s.id });
      db.exec('COMMIT');
      s = one(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE s.id=:id`, { id: s.id });
      if (changed && !opts.fromGit) for (const f of hooks.publish) f(s, b.files, author, String(b.note || ''), opts.merge);
      notify(audience(s));
      return { skill: pubSkill(s, me.id), changed };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // Routes: [method, regex, handler(ctx)] where ctx = {me, body, m, req, res, query}. Handlers return JSON.
  const routes = [];
  const r = (method, pattern, open, fn) => routes.push([method, new RegExp(`^${pattern}$`), open, fn]);
  const PUBLIC_ROUTE = true;

  r('POST', '/api/signup', PUBLIC_ROUTE, ({ body, res }) => {
    const email = String(body.email || '').trim().toLowerCase(), handle = String(body.handle || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'enter a valid email');
    if (!NAME_RE.test(handle)) fail(400, 'handle must be lowercase letters, digits and dashes');
    if (String(body.password || '').length < 8) fail(400, 'password must be at least 8 characters');
    if (one('SELECT 1 x FROM users WHERE email=:e OR handle=:h', { e: email, h: handle })) fail(409, 'that email or handle is taken');
    if (one('SELECT 1 x FROM orgs WHERE slug=:h', { h: handle })) fail(409, 'that handle is taken');
    const id = rid(9);
    run('INSERT INTO users VALUES(:id,:e,:h,:n,:p,:c)', { id, e: email, h: handle, n: String(body.name || handle).slice(0, 80), p: hashPw(body.password), c: now() });
    setCookie(res, issueToken(id, 'web', 'browser'));
    return { user: userOut(one('SELECT * FROM users WHERE id=:id', { id })) };
  });
  r('POST', '/api/login', PUBLIC_ROUTE, ({ body, res }) => {
    const u = one('SELECT * FROM users WHERE email=:e', { e: String(body.email || '').trim().toLowerCase() });
    if (!u || !checkPw(String(body.password || ''), u.pw)) fail(401, 'wrong email or password');
    setCookie(res, issueToken(u.id, 'web', 'browser'));
    return { user: userOut(u) };
  });
  r('POST', '/api/logout', false, ({ me, req, res }) => {
    const cookie = /(?:^|;\s*)sn=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (cookie) run('DELETE FROM tokens WHERE hash=:h', { h: sha(cookie) });
    res.setHeader('Set-Cookie', 'sn=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return { ok: true, me: me.id };
  });
  r('GET', '/api/me', false, ({ me }) => ({
    user: userOut(me), email: me.email, chat_unread: chatList(me).reduce((n, c) => n + c.unread + c.waiting, 0),
    orgs: all('SELECT o.slug, o.name, m.role FROM members m JOIN orgs o ON o.id=m.org_id WHERE m.user_id=:u ORDER BY o.name', { u: me.id }),
  }));

  // Device sign-in for the command-line tool: it shows a short code, you approve it on the website.
  r('POST', '/api/device/start', PUBLIC_ROUTE, ({ body }) => {
    const device_code = rid(24), user_code = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(....)/, '$1-');
    run('INSERT INTO devices VALUES(:d,:uc,:l,NULL,NULL,:c)', { d: device_code, uc: user_code, l: String(body.label || 'device').slice(0, 80), c: now() });
    return { device_code, user_code, verify_url: `${baseUrl}/device?code=${user_code}`, interval: 2 };
  });
  r('POST', '/api/device/poll', PUBLIC_ROUTE, ({ body }) => {
    const d = one('SELECT * FROM devices WHERE device_code=:d', { d: String(body.device_code || '') });
    if (!d || now() - d.created > 15 * 60e3) fail(410, 'sign-in code expired; run login again');
    if (!d.token) fail(428, 'waiting for approval');
    run('DELETE FROM devices WHERE device_code=:d', { d: d.device_code });
    return { token: d.token };
  });
  r('POST', '/api/device/approve', false, ({ me, body }) => {
    const d = one('SELECT * FROM devices WHERE user_code=:c AND token IS NULL', { c: String(body.user_code || '').trim().toUpperCase() });
    if (!d || now() - d.created > 15 * 60e3) fail(404, 'that code is wrong or expired');
    run('UPDATE devices SET user_id=:u, token=:t WHERE device_code=:d', { u: me.id, t: issueToken(me.id, 'cli', d.label), d: d.device_code });
    return { ok: true, label: d.label };
  });
  r('GET', '/api/tokens', false, ({ me }) => ({ tokens: all(`SELECT id, kind, scope, label, created, used FROM tokens WHERE user_id=:u AND kind IN ('cli','key','connector') ORDER BY created DESC`, { u: me.id }) }));
  // API keys for cloud runs and tools that cannot do the device sign-in. "read" keys sync and search only.
  r('POST', '/api/keys', false, ({ me, body }) => {
    const scope = body.scope || 'read';
    if (!['read', 'write'].includes(scope)) fail(400, 'scope must be read or write');
    const label = String(body.label || '').trim().slice(0, 80) || fail(400, 'give the key a name, like "Cursor cloud"');
    return { key: issueToken(me.id, 'key', label, scope), label, scope };
  });
  r('DELETE', '/api/tokens/([\\w-]+)', false, ({ me, m }) => { run('DELETE FROM tokens WHERE (id=:id OR grant_id=:id) AND user_id=:u', { id: m[1], u: me.id }); return { ok: true }; });

  // Connector sign-in (OAuth 2.1 with PKCE, as MCP clients expect). The browser page /oauth/authorize asks the person; these two routes back it.
  const getClient = (id) => one('SELECT * FROM oauth_clients WHERE id=:id', { id: String(id || '') }) || fail(400, 'unknown app; remove the connector and add it again');
  const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
  const redirectOk = (client, uri) => {
    let x; try { x = new URL(uri); } catch { return false; }
    return JSON.parse(client.redirect_uris).some((r) => {
      if (r === uri) return true;
      const y = new URL(r); // native apps pick a free port each time (RFC 8252)
      return x.protocol === 'http:' && LOOPBACK.includes(x.hostname) && y.protocol === 'http:' && y.hostname === x.hostname && y.pathname === x.pathname;
    });
  };
  r('GET', '/api/oauth/client', false, ({ query }) => {
    const c = getClient(query.get('client_id'));
    if (!redirectOk(c, query.get('redirect_uri'))) fail(400, 'this app sent an address it did not register');
    return { name: c.name, host: new URL(query.get('redirect_uri')).host || new URL(query.get('redirect_uri')).protocol };
  });
  r('POST', '/api/oauth/approve', false, ({ me, body }) => {
    if (me.tkind !== 'web') fail(403, 'approve this in your browser');
    const c = getClient(body.client_id);
    if (!redirectOk(c, body.redirect_uri)) fail(400, 'this app sent an address it did not register');
    const to = new URL(body.redirect_uri);
    if (body.state) to.searchParams.set('state', body.state);
    to.searchParams.set('iss', baseUrl);
    if (!body.allow) { to.searchParams.set('error', 'access_denied'); return { redirect: to.href }; }
    if (body.code_challenge_method !== 'S256' || !/^[\w-]{43,128}$/.test(body.code_challenge || '')) fail(400, 'this app did not send a PKCE challenge');
    const code = rid(24);
    run('INSERT INTO oauth_codes VALUES(:h,:c,:u,:r,:ch,:s,:t)', { h: sha(code), c: c.id, u: me.id, r: body.redirect_uri, ch: body.code_challenge,
      s: body.scope === 'read' ? 'read' : 'write', t: now() });
    to.searchParams.set('code', code);
    return { redirect: to.href };
  });

  // Friends: a request is a row (a=requester, b=addressee, pending); accepting flips it to accepted.
  r('GET', '/api/friends', false, ({ me }) => {
    const rows = all(`SELECT f.a, f.b, f.status, u.id, u.handle, u.name FROM friends f JOIN users u ON u.id = CASE WHEN f.a=:u THEN f.b ELSE f.a END WHERE f.a=:u OR f.b=:u`, { u: me.id });
    return {
      friends: rows.filter((x) => x.status === 'accepted').map(userOut),
      incoming: rows.filter((x) => x.status === 'pending' && x.b === me.id).map(userOut),
      outgoing: rows.filter((x) => x.status === 'pending' && x.a === me.id).map(userOut),
    };
  });
  r('POST', '/api/friends', false, ({ me, body }) => {
    const who = String(body.who || '').trim().toLowerCase().replace(/^@/, '');
    const them = one('SELECT * FROM users WHERE handle=:w OR email=:w', { w: who }) || fail(404, 'no one with that handle or email');
    if (them.id === me.id) fail(400, 'that is you');
    const reverse = one('SELECT * FROM friends WHERE a=:t AND b=:u', { t: them.id, u: me.id });
    if (reverse) run(`UPDATE friends SET status='accepted' WHERE a=:t AND b=:u`, { t: them.id, u: me.id });
    else run(`INSERT OR IGNORE INTO friends VALUES(:u,:t,'pending',:c)`, { u: me.id, t: them.id, c: now() });
    notify([me.id, them.id]);
    return { status: reverse ? 'accepted' : 'pending', user: userOut(them) };
  });
  r('DELETE', '/api/friends/([\\w-]+)', false, ({ me, m }) => {
    run('DELETE FROM friends WHERE (a=:u AND b=:t) OR (a=:t AND b=:u)', { u: me.id, t: m[1] });
    notify([me.id, m[1]]);
    return { ok: true };
  });

  // Organizations
  r('POST', '/api/orgs', false, ({ me, body }) => {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!NAME_RE.test(slug)) fail(400, 'organization id must be lowercase letters, digits and dashes');
    if (one('SELECT 1 x FROM orgs WHERE slug=:s', { s: slug }) || one('SELECT 1 x FROM users WHERE handle=:s', { s: slug })) fail(409, 'that id is taken');
    const id = rid(9);
    run('INSERT INTO orgs(id,slug,name,invite,created) VALUES(:id,:s,:n,:i,:c)', { id, s: slug, n: String(body.name || slug).slice(0, 80), i: rid(12), c: now() });
    run(`INSERT INTO members VALUES(:o,:u,'owner')`, { o: id, u: me.id });
    return { org: { slug, name: body.name || slug, role: 'owner' } };
  });
  r('GET', '/api/orgs/([\\w-]+)', false, ({ me, m }) => {
    const o = getOrg(m[1]);
    const myRole = role(o.id, me.id) || fail(404, 'no such organization');
    return {
      org: { slug: o.slug, name: o.name, role: myRole, invite: ['owner', 'admin'].includes(myRole) ? `${baseUrl}/join?code=${o.invite}` : null,
        plan: o.plan, review: o.review, git: gitDir ? `${baseUrl}/git/${o.slug}.git` : null, free_seats: FREE_SEATS, billing: !!billing, price: billing?.priceLabel || null, can_bill: !!billing && ['owner', 'admin'].includes(myRole) },
      members: all('SELECT u.id, u.handle, u.name, m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.org_id=:o ORDER BY u.handle', { o: o.id }),
      skills: all(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE s.owner_org=:o ORDER BY s.name`, { o: o.id }).map((s) => pubSkill(s, me.id)),
    };
  });
  r('POST', '/api/orgs/([\\w-]+)/invite', false, ({ me, m }) => {
    const o = getOrg(m[1]);
    if (!isAdmin(o.id, me.id)) fail(403, 'only admins can reset the invite link');
    const invite = rid(12);
    run('UPDATE orgs SET invite=:i WHERE id=:o', { i: invite, o: o.id });
    return { invite: `${baseUrl}/join?code=${invite}` };
  });
  r('POST', '/api/join', false, ({ me, body }) => {
    const o = one('SELECT * FROM orgs WHERE invite=:i', { i: String(body.code || '') }) || fail(404, 'that invite link is wrong or was reset');
    if (!role(o.id, me.id) && o.plan !== 'team' && seats(o.id) >= FREE_SEATS)
      fail(402, `${o.name} is on the free plan, which allows ${FREE_SEATS} people. Ask an admin to upgrade it to Team.`);
    run(`INSERT OR IGNORE INTO members VALUES(:o,:u,'member')`, { o: o.id, u: me.id });
    syncSeats(o.id);
    notify([me.id]);
    return { org: { slug: o.slug, name: o.name } };
  });
  r('POST', '/api/orgs/([\\w-]+)/members/([\\w-]+)', false, ({ me, m, body }) => {
    const o = getOrg(m[1]);
    if (role(o.id, me.id) !== 'owner') fail(403, 'only owners can change roles');
    if (!ROLES.includes(body.role)) fail(400, `role must be one of ${ROLES.join(', ')}`);
    if (m[2] === me.id && body.role !== 'owner' && lastOwner(o.id)) fail(400, 'make someone else an owner first');
    run('UPDATE members SET role=:r WHERE org_id=:o AND user_id=:u', { r: body.role, o: o.id, u: m[2] });
    return { ok: true };
  });
  const lastOwner = (orgId) => one(`SELECT count(*) n FROM members WHERE org_id=:o AND role='owner'`, { o: orgId }).n === 1;
  r('DELETE', '/api/orgs/([\\w-]+)/members/([\\w-]+)', false, ({ me, m }) => {
    const o = getOrg(m[1]);
    const self = m[2] === me.id;
    if (!self && !isAdmin(o.id, me.id)) fail(403, 'only admins can remove people');
    if (role(o.id, m[2]) === 'owner' && (lastOwner(o.id) || role(o.id, me.id) !== 'owner')) fail(400, 'cannot remove that owner');
    run('DELETE FROM members WHERE org_id=:o AND user_id=:u', { o: o.id, u: m[2] });
    syncSeats(o.id);
    notify([m[2]]);
    return { ok: true };
  });

  r('GET', '/api/plans', PUBLIC_ROUTE, () => ({ free_seats: FREE_SEATS, team: billing?.priceLabel || '$8 per person a month', billing: !!billing }));
  // Billing. Team is priced per person; Stripe holds the card and invoices, the webhook below sets the plan.
  const seats = (orgId) => one('SELECT count(*) n FROM members WHERE org_id=:o', { o: orgId }).n;
  const billingOrg = (slug, me) => {
    if (!billing) fail(503, 'billing is not set up on this server');
    const o = getOrg(slug);
    if (!isAdmin(o.id, me.id)) fail(403, 'only owners and admins manage billing');
    return o;
  };
  // Keep the subscription quantity equal to the number of people. Best effort: a failure is logged and fixed by the next change.
  function syncSeats(orgId) {
    const o = one('SELECT plan, stripe_sub FROM orgs WHERE id=:o', { o: orgId });
    if (!billing || o.plan !== 'team' || !o.stripe_sub) return;
    const n = seats(orgId);
    (async () => {
      const sub = await billing.stripe('GET', `/subscriptions/${o.stripe_sub}`);
      const item = sub.items.data[0];
      if (item && item.quantity !== n) await billing.stripe('POST', `/subscription_items/${item.id}`, { quantity: n, proration_behavior: 'create_prorations' });
    })().catch((e) => console.error('seat sync', orgId, e.message));
  }
  r('POST', '/api/orgs/([\\w-]+)/billing/checkout', false, async ({ me, m }) => {
    const o = billingOrg(m[1], me);
    if (o.plan === 'team') fail(400, `${o.name} is already on Team`);
    const session = await billing.stripe('POST', '/checkout/sessions', {
      mode: 'subscription', client_reference_id: o.id, customer: o.stripe_customer || undefined, customer_email: o.stripe_customer ? undefined : me.email,
      line_items: [{ price: billing.price, quantity: Math.max(seats(o.id), 1) }],
      subscription_data: { metadata: { org: o.id } }, metadata: { org: o.id }, allow_promotion_codes: true,
      success_url: `${baseUrl}/o/${o.slug}?billing=done`, cancel_url: `${baseUrl}/o/${o.slug}` });
    return { url: session.url };
  });
  r('POST', '/api/orgs/([\\w-]+)/billing/portal', false, async ({ me, m }) => {
    const o = billingOrg(m[1], me);
    if (!o.stripe_customer) fail(400, `${o.name} has no billing account yet`);
    return { url: (await billing.stripe('POST', '/billing_portal/sessions', { customer: o.stripe_customer, return_url: `${baseUrl}/o/${o.slug}` })).url };
  });
  // Stripe events. Signed with the webhook secret; the raw body is checked before anything is read from it.
  async function stripeWebhook(req, res) {
    const raw = await readBody(req);
    if (!billing || !stripeVerify(raw, req.headers['stripe-signature'], billing.webhookSecret)) return json(res, 400, { error: 'bad signature' });
    const ev = JSON.parse(raw), x = ev.data.object;
    if (ev.type === 'checkout.session.completed' && x.mode === 'subscription' && x.client_reference_id)
      run(`UPDATE orgs SET plan='team', stripe_customer=:c, stripe_sub=:s WHERE id=:o`, { c: x.customer, s: x.subscription, o: x.client_reference_id });
    if (ev.type.startsWith('customer.subscription.') && x.metadata?.org) {
      const active = ['active', 'trialing', 'past_due'].includes(x.status) && ev.type !== 'customer.subscription.deleted';
      run('UPDATE orgs SET plan=:p, stripe_customer=:c, stripe_sub=:s WHERE id=:o', { p: active ? 'team' : 'free', c: x.customer, s: active ? x.id : null, o: x.metadata.org });
    }
    return json(res, 200, { received: true });
  }

  // Skills
  r('GET', '/api/skills', false, ({ me, query }) => {
    const q = `%${(query.get('q') || '').toLowerCase()}%`;
    // Name and description matches first, then matches in the SKILL.md text.
    return {
      skills: all(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE ${VISIBLE} AND s.version>0
        AND (lower(s.name) LIKE :q OR lower(s.description) LIKE :q OR lower(s.body) LIKE :q)
        ORDER BY (lower(s.name) LIKE :q OR lower(s.description) LIKE :q) DESC, s.updated DESC LIMIT 300`, { u: me.id, q }).map((s) => pubSkill(s, me.id)),
    };
  });
  // "owner/name" or an id -> the skill, for commands and agents.
  r('GET', '/api/resolve', false, ({ me, query }) => {
    const ref = String(query.get('ref') || '').replace(/^@/, '');
    const [owner, name] = ref.includes('/') ? ref.split('/') : [null, ref];
    const hits = all(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE ${VISIBLE} AND (s.id=:ref OR (s.name=:n AND (:o IS NULL OR coalesce(u.handle, o.slug)=:o)))`,
      { u: me.id, ref, n: name, o: owner });
    if (hits.length !== 1) fail(hits.length ? 409 : 404, hits.length ? `several skills are named ${name}: ${hits.map((s) => `${s.owner}/${s.name}`).join(', ')}` : `no skill ${ref} that you can see`);
    return { skill: pubSkill(hits[0], me.id) };
  });
  r('POST', '/api/skills/push', false, ({ me, body }) => pushSkill(me, body));
  r('GET', '/api/skills/([\\w-]+)', false, ({ me, m }) => {
    const s = visibleSkill(m[1], me.id);
    const v = one('SELECT bundle FROM versions WHERE skill_id=:s AND version=:v', { s: s.id, v: s.version });
    const files = JSON.parse(v?.bundle || '{}');
    return {
      skill: pubSkill(s, me.id),
      files: Object.keys(files).sort().map((p) => ({ path: p, size: Buffer.from(files[p], 'base64').length })),
      skill_md: files['SKILL.md'] ? Buffer.from(files['SKILL.md'], 'base64').toString('utf8') : '',
      versions: all('SELECT v.version, v.hash, v.note, v.created, u.handle author FROM versions v JOIN users u ON u.id=v.author WHERE v.skill_id=:s ORDER BY v.version DESC', { s: s.id }),
    };
  });
  r('GET', '/api/skills/([\\w-]+)/bundle', false, ({ me, m }) => bundleOf(m[1], me.id));
  r('GET', '/api/skills/([\\w-]+)/file', false, ({ me, m, query }) => {
    const files = bundleOf(m[1], me.id).files, p = query.get('path') || 'SKILL.md';
    if (!(p in files)) fail(404, `no file ${p}; files: ${Object.keys(files).join(', ')}`);
    return { path: p, text: Buffer.from(files[p], 'base64').toString('utf8') };
  });
  r('PATCH', '/api/skills/([\\w-]+)', false, ({ me, m, body }) => {
    const s = visibleSkill(m[1], me.id);
    if (!canManage(s, me.id)) fail(403, s.owner_org ? 'only admins decide who gets an organization skill' : 'you cannot change this skill');
    const allowed = s.owner_org ? VIS_ORG : VIS_USER;
    const visibility = body.visibility ?? s.visibility;
    if (!allowed.includes(visibility)) fail(400, `visibility must be one of ${allowed.join(', ')}`);
    const required = s.owner_org && body.required !== undefined ? (body.required ? 1 : 0) : s.required;
    const before = audience(s);
    run('UPDATE skills SET visibility=:v, required=:r, updated=:t WHERE id=:s', { v: visibility, r: required, t: now(), s: s.id });
    notify([...before, ...audience(s)]);
    return { skill: pubSkill(visibleSkill(s.id, me.id), me.id) };
  });
  r('POST', '/api/skills/([\\w-]+)/rollback', false, ({ me, m, body }) => {
    const s = visibleSkill(m[1], me.id);
    if (!canEdit(s, me.id)) fail(403, 'you cannot change this skill');
    const v = one('SELECT bundle FROM versions WHERE skill_id=:s AND version=:v', { s: s.id, v: Number(body.version) }) || fail(404, 'no such version');
    return pushSkill(me, { org: s.owner_org ? s.owner : undefined, name: s.name, files: JSON.parse(v.bundle), note: `rolled back to version ${body.version}` });
  });
  function deleteSkill(me, s, opts = {}) {
    if (!canManage(s, me.id)) fail(403, 'only admins can delete this skill');
    const who = audience(s);
    run('DELETE FROM skills WHERE id=:s', { s: s.id });
    if (!opts.fromGit) for (const f of hooks.remove) f(s, me.id);
    notify(who);
    return { ok: true };
  }
  r('DELETE', '/api/skills/([\\w-]+)', false, ({ me, m }) => deleteSkill(me, visibleSkill(m[1], me.id)));
  r('POST', '/api/skills/([\\w-]+)/install', false, ({ me, m }) => {
    const s = visibleSkill(m[1], me.id);
    run('INSERT OR IGNORE INTO installs VALUES(:u,:s)', { u: me.id, s: s.id });
    notify([me.id]);
    return { ok: true };
  });
  r('DELETE', '/api/skills/([\\w-]+)/install', false, ({ me, m }) => {
    run('DELETE FROM installs WHERE user_id=:u AND skill_id=:s', { u: me.id, s: m[1] });
    notify([me.id]);
    return { ok: true };
  });

  // Suggested changes: anyone who can see a skill but not edit it proposes new files; an editor approves or declines.
  r('POST', '/api/skills/([\\w-]+)/proposals', false, ({ me, m, body }) => ({ proposal: propose(me, visibleSkill(m[1], me.id), body.files, { note: body.note }) }));
  const proposalOut = (p, u) => {
    const files = JSON.parse(p.bundle), base = p.base_bundle ? JSON.parse(p.base_bundle) : versionFiles(p.skill_id, p.base_version);
    const cur = p.version ? versionFiles(p.skill_id, p.version) : {};
    const md = (f) => (f['SKILL.md'] ? Buffer.from(f['SKILL.md'], 'base64').toString('utf8') : '');
    const approvals = all('SELECT u.handle FROM approvals a JOIN users u ON u.id=a.user_id WHERE a.proposal_id=:p ORDER BY a.created', { p: p.id }).map((r) => r.handle);
    const needs = Math.max(reviewsNeeded(p), 1);
    return { id: p.id, skill_id: p.skill_id, skill: `${p.owner}/${p.name}`, author: p.author, note: p.note, created: p.created, base_version: p.base_version,
      current_version: p.version, new_skill: !p.version, branch: p.branch?.replace(/^refs\/heads\//, '') || null, commit: p.commit_sha,
      approvals, needs, can_approve: canEdit(p, u) && !(reviewsNeeded(p) > 0 && p.user_id === u) && !approvals.includes(p.my_handle),
      can_close: canEdit(p, u) || p.user_id === u, mine: p.user_id === u,
      conflicts: merge3(base, files, cur).conflicts,
      changed: [...new Set([...Object.keys(files), ...Object.keys(base)])].filter((f) => files[f] !== base[f]).sort(),
      files: Object.keys(files).sort(), skill_md: md(files), base_md: md(base) };
  };
  const PROPOSAL_SQL = `SELECT p.*, a.handle author, :h my_handle, s.owner_user, s.owner_org, s.name, s.version, coalesce(u.handle, o.slug) owner
      FROM proposals p JOIN users a ON a.id=p.user_id JOIN skills s ON s.id=p.skill_id LEFT JOIN users u ON u.id=s.owner_user LEFT JOIN orgs o ON o.id=s.owner_org`;
  r('GET', '/api/proposals', false, ({ me, query }) => ({
    proposals: all(`${PROPOSAL_SQL} WHERE p.status='open' AND (:sid IS NULL OR p.skill_id=:sid) AND (:org IS NULL OR o.slug=:org) ORDER BY p.created DESC`,
      { sid: query.get('skill') || null, org: query.get('org') || null, h: me.handle })
      .filter((p) => canEdit(p, me.id) || p.user_id === me.id).map((p) => proposalOut(p, me.id)),
  }));
  const getProposal = (id, h = '') => one(`${PROPOSAL_SQL} WHERE p.id=:id AND p.status='open'`, { id, h }) || fail(404, 'no open change request with that id');
  // Approve: with a review rule, someone other than the author approves, and the change merges once it has enough approvals.
  // Files changed on both sides since the request started are a conflict; the author updates the request first.
  function approve(me, id) {
    const p = getProposal(id, me.handle), s = visibleSkill(p.skill_id, me.id);
    if (!canEdit(s, me.id)) fail(403, 'only editors and admins can approve changes');
    const needs = reviewsNeeded(s);
    if (needs > 0 && p.user_id === me.id) fail(403, 'someone else has to approve your own change');
    run('INSERT OR IGNORE INTO approvals VALUES(:p,:u,:t)', { p: p.id, u: me.id, t: now() });
    const got = one('SELECT count(*) n FROM approvals WHERE proposal_id=:p', { p: p.id }).n;
    if (got < Math.max(needs, 1)) return { merged: false, approvals: got, needs, proposal: proposalOut(getProposal(p.id, me.handle), me.id) };
    const base = p.base_bundle ? JSON.parse(p.base_bundle) : versionFiles(s.id, p.base_version);
    const { files, conflicts } = merge3(base, JSON.parse(p.bundle), s.version ? versionFiles(s.id, s.version) : {});
    if (conflicts.length) fail(409, `${s.owner}/${s.name} changed since this request started, and both changed ${conflicts.join(', ')}. The author needs to update the request.`);
    const out = pushSkill(me, { org: s.owner_org ? s.owner : undefined, name: s.name, files, note: p.note || 'approved change' }, p.user_id, { direct: true, merge: p.commit_sha });
    run(`UPDATE proposals SET status='approved' WHERE id=:id`, { id: p.id });
    return { merged: true, ...out };
  }
  r('POST', '/api/proposals/([\\w-]+)/approve', false, ({ me, m }) => approve(me, m[1]));
  function closeProposal(id, status) {
    const p = one('SELECT skill_id FROM proposals WHERE id=:id', { id });
    run('UPDATE proposals SET status=:st WHERE id=:id', { id, st: status });
    // A new skill that only existed as this request goes away with it.
    if (!one(`SELECT 1 x FROM proposals WHERE skill_id=:s AND status='open'`, { s: p.skill_id })) run('DELETE FROM skills WHERE id=:s AND version=0', { s: p.skill_id });
  }
  r('POST', '/api/proposals/([\\w-]+)/decline', false, ({ me, m }) => {
    const p = getProposal(m[1]), s = visibleSkill(p.skill_id, me.id);
    if (!canEdit(s, me.id) && p.user_id !== me.id) fail(403, 'only editors or the author can close a change request');
    closeProposal(p.id, 'declined');
    return { ok: true };
  });
  r('POST', '/api/orgs/([\\w-]+)/settings', false, ({ me, m, body }) => {
    const o = getOrg(m[1]);
    if (!isAdmin(o.id, me.id)) fail(403, 'only admins change review rules');
    const review = Number(body.review);
    if (![0, 1, 2, 3].includes(review)) fail(400, 'review must be 0, 1, 2 or 3 approvals');
    run('UPDATE orgs SET review=:r WHERE id=:o', { r: review, o: o.id });
    return { ok: true, review };
  });

  // Chat: people and their agents in one conversation (a direct message or a group).
  // A message sent with a website session is from the person; one sent with a device or API key is from that person's agent.
  // What an agent may send is checked against its owner's permissions; people are never gated.
  const isAgent = (me) => me.tkind !== 'web';
  const convoOf = (id, u) => one('SELECT c.*, cm.role my_role, cm.read my_read FROM convos c JOIN convo_members cm ON cm.convo_id=c.id AND cm.user_id=:u WHERE c.id=:id', { id, u }) || fail(404, 'no such conversation');
  const memberIds = (cid) => all('SELECT user_id FROM convo_members WHERE convo_id=:c', { c: cid }).map((r) => r.user_id);
  const agentsOn = (c) => JSON.parse(c.agents || '{}');
  // Effective permission: this conversation's setting, else the person's default, else the built-in default.
  const mode = (u, cid, dir, kind) =>
    one('SELECT mode FROM grants WHERE owner=:u AND other=:o AND dir=:d AND kind=:k', { u, o: cid, d: dir, k: kind })?.mode ??
    one(`SELECT mode FROM grants WHERE owner=:u AND other='*' AND dir=:d AND kind=:k`, { u, d: dir, k: kind })?.mode ?? DEFAULT_GRANTS[dir][kind];
  const grantsFor = (u, cid) => Object.fromEntries(['out', 'in'].map((dir) => [dir, Object.fromEntries(KINDS.map((k) => [k, mode(u, cid, dir, k)]))]));
  // Can this stream (or token) see this message? Held and declined messages show only to the sender's own account;
  // an agent sees nothing in a conversation where its owner turned it off, nor kinds its owner keeps from it.
  const sees = (m, u, agent, c) => {
    if (m.status !== 'sent' && m.user_id !== u) return false;
    if (!agent) return true;
    if (!agentsOn(c)[u]) return false;
    return m.user_id === u || mode(u, c.id, 'in', m.kind) === 'allow';
  };
  const msgOut = (m) => {
    const u = one('SELECT * FROM users WHERE id=:id', { id: m.user_id });
    return { id: m.id, convo: m.convo_id, from: userOut(u), agent: m.agent, kind: m.kind, text: m.text, data: m.data ? JSON.parse(m.data) : null, status: m.status, created: m.created };
  };
  const convoOut = (c, me) => {
    const members = all('SELECT u.id, u.handle, u.name, cm.role FROM convo_members cm JOIN users u ON u.id=cm.user_id WHERE cm.convo_id=:c ORDER BY u.handle', { c: c.id });
    const on = agentsOn(c);
    const last = all('SELECT * FROM messages WHERE convo_id=:c ORDER BY created DESC LIMIT 20', { c: c.id }).find((m) => sees(m, me.id, false, c));
    const other = c.kind === 'dm' ? members.find((x) => x.id !== me.id) : null;
    return {
      id: c.id, kind: c.kind, name: c.kind === 'dm' ? other?.name || other?.handle || 'Just you' : c.name, last_at: c.last,
      members: members.map((x) => ({ ...userOut(x), role: x.role, agent: !!on[x.id] })), my_agent: !!on[me.id],
      invite: c.kind === 'group' ? `${baseUrl}/c?code=${c.invite}` : null,
      last: last ? msgOut(last) : null,
      unread: one(`SELECT count(*) n FROM messages WHERE convo_id=:c AND status='sent' AND user_id!=:u AND created>:r`, { c: c.id, u: me.id, r: c.my_read }).n,
      waiting: one(`SELECT count(*) n FROM messages WHERE convo_id=:c AND status='held' AND user_id=:u`, { c: c.id, u: me.id }).n,
    };
  };
  function chatList(me) {
    return all('SELECT c.*, cm.role my_role, cm.read my_read FROM convos c JOIN convo_members cm ON cm.convo_id=c.id AND cm.user_id=:u ORDER BY c.last DESC', { u: me.id })
      .map((c) => convoOut(c, me));
  }
  // Tell every member's open screens and agents about a message, each only what they may see.
  const broadcast = (c, m) => {
    c = one('SELECT * FROM convos WHERE id=:id', { id: c.id });
    emit(memberIds(c.id), 'message', () => ({ convo: c.id, message: msgOut(m) }), (res, u) => sees(m, u, !res.human, c));
  };
  const addMember = (cid, u, role = 'member') => {
    run('INSERT OR IGNORE INTO convo_members(convo_id,user_id,role,read) VALUES(:c,:u,:r,0)', { c: cid, u, r: role });
  };
  const setAgent = (cid, u, on) => {
    const c = one('SELECT agents FROM convos WHERE id=:id', { id: cid });
    run('UPDATE convos SET agents=:a WHERE id=:id', { a: JSON.stringify({ ...JSON.parse(c.agents), [u]: !!on }), id: cid });
  };

  r('GET', '/api/convos', false, ({ me }) => ({ convos: chatList(me), kinds: KIND_LABELS }));
  // {with: handle} opens (or reopens) a direct conversation with a friend; {name} starts a group with an invite link.
  r('POST', '/api/convos', false, ({ me, body }) => {
    let c;
    if (body.with) {
      const who = String(body.with).trim().toLowerCase().replace(/^@/, '');
      const them = one('SELECT * FROM users WHERE handle=:w OR email=:w', { w: who }) || fail(404, 'no one with that handle or email');
      if (them.id === me.id) fail(400, 'that is you');
      if (!friendIds(me.id).includes(them.id)) fail(403, `you and @${them.handle} need to be friends first`);
      c = one(`SELECT c.* FROM convos c WHERE c.kind='dm' AND c.id IN (SELECT convo_id FROM convo_members WHERE user_id=:a) AND c.id IN (SELECT convo_id FROM convo_members WHERE user_id=:b)`, { a: me.id, b: them.id });
      if (!c) {
        const id = rid(9);
        run(`INSERT INTO convos(id,kind,agents,created_by,created,last) VALUES(:id,'dm',:a,:u,:t,:t)`, { id, a: JSON.stringify({ [me.id]: !!isAgent(me), [them.id]: false }), u: me.id, t: now() });
        addMember(id, me.id, 'owner'); addMember(id, them.id, 'owner');
        c = one('SELECT * FROM convos WHERE id=:id', { id });
        emit([them.id], 'convo', () => ({ convo: id }));
      }
    } else {
      const name = String(body.name || '').trim().slice(0, 80) || fail(400, 'give the group a name');
      const id = rid(9);
      run(`INSERT INTO convos(id,kind,name,invite,agents,created_by,created,last) VALUES(:id,'group',:n,:i,:a,:u,:t,:t)`,
        { id, n: name, i: rid(12), a: JSON.stringify({ [me.id]: body.agent ?? isAgent(me) }), u: me.id, t: now() });
      addMember(id, me.id, 'owner');
      for (const h of [].concat(body.people || [])) {
        const f = one('SELECT id FROM users WHERE handle=:h', { h: String(h).replace(/^@/, '') });
        if (f && friendIds(me.id).includes(f.id)) { addMember(id, f.id); emit([f.id], 'convo', () => ({ convo: id })); }
      }
      c = one('SELECT * FROM convos WHERE id=:id', { id });
    }
    return { convo: convoOut(convoOf(c.id, me.id), me) };
  });
  // "@bob" (your direct conversation), a group name or an id -> the conversation, for commands and agents.
  r('GET', '/api/convos/resolve', false, ({ me, query }) => {
    const ref = String(query.get('ref') || '').trim(), list = chatList(me);
    const h = ref.replace(/^@/, '').toLowerCase();
    const hits = list.filter((c) => c.id === ref || (c.kind === 'dm' && c.members.some((x) => x.handle === h && x.id !== me.id)) || (c.kind === 'group' && c.name.toLowerCase() === ref.toLowerCase()));
    if (hits.length !== 1) fail(hits.length ? 409 : 404, hits.length ? `several conversations match ${ref}; use an id: ${hits.map((c) => c.id).join(', ')}` : `no conversation ${ref}; list them with skillnet chats`);
    return { convo: hits[0] };
  });
  r('GET', '/api/convos/([\\w-]+)', false, ({ me, m, query }) => {
    const c = convoOf(m[1], me.id);
    if (isAgent(me) && !agentsOn(c)[me.id]) fail(403, 'your agent is turned off in this conversation; its owner can turn it on');
    const since = Number(query.get('since') || 0);
    const msgs = all('SELECT * FROM messages WHERE convo_id=:c AND created>:s ORDER BY created DESC LIMIT 200', { c: c.id, s: since }).reverse()
      .filter((x) => sees(x, me.id, isAgent(me), c));
    if (!isAgent(me)) run('UPDATE convo_members SET read=:t WHERE convo_id=:c AND user_id=:u', { t: now(), c: c.id, u: me.id });
    return { convo: convoOut(c, me), messages: msgs.map(msgOut), permissions: grantsFor(me.id, c.id) };
  });
  r('PATCH', '/api/convos/([\\w-]+)', false, ({ me, m, body }) => {
    const c = convoOf(m[1], me.id);
    if (body.agent !== undefined) {
      if (isAgent(me) && body.agent) fail(403, 'only you can bring your agent into a conversation');
      setAgent(c.id, me.id, body.agent);
    }
    if (body.name !== undefined) {
      if (c.kind !== 'group' || c.my_role !== 'owner') fail(403, 'only the group owner can rename it');
      run('UPDATE convos SET name=:n WHERE id=:id', { n: String(body.name).trim().slice(0, 80) || c.name, id: c.id });
    }
    emit(memberIds(c.id), 'convo', () => ({ convo: c.id }));
    return { convo: convoOut(convoOf(c.id, me.id), me) };
  });
  r('POST', '/api/convos/([\\w-]+)/invite', false, ({ me, m }) => {
    const c = convoOf(m[1], me.id);
    if (c.kind !== 'group' || c.my_role !== 'owner') fail(403, 'only the group owner can reset the invite link');
    const invite = rid(12);
    run('UPDATE convos SET invite=:i WHERE id=:id', { i: invite, id: c.id });
    return { invite: `${baseUrl}/c?code=${invite}` };
  });
  // Anyone in a group can share its link; joining brings you in, your agent stays out until you turn it on.
  r('GET', '/api/convos/invite/([\\w-]+)', PUBLIC_ROUTE, ({ m }) => {
    const c = one(`SELECT * FROM convos WHERE invite=:i AND kind='group'`, { i: m[1] }) || fail(404, 'that invite link is wrong or was reset');
    const people = all('SELECT u.handle, u.name FROM convo_members cm JOIN users u ON u.id=cm.user_id WHERE cm.convo_id=:c ORDER BY cm.read DESC LIMIT 6', { c: c.id });
    return { name: c.name, people: people.length, faces: people.map((p) => p.name || p.handle), agents: Object.values(agentsOn(c)).filter(Boolean).length };
  });
  r('POST', '/api/convos/join', false, ({ me, body }) => {
    const code = String(body.code || '').replace(/^.*code=/, '');
    const c = one(`SELECT * FROM convos WHERE invite=:i AND kind='group'`, { i: code }) || fail(404, 'that invite link is wrong or was reset');
    const fresh = !one('SELECT 1 x FROM convo_members WHERE convo_id=:c AND user_id=:u', { c: c.id, u: me.id });
    addMember(c.id, me.id);
    if (fresh) {
      const id = rid(9), t = now();
      run(`INSERT INTO messages(id,convo_id,user_id,kind,text,status,created) VALUES(:id,:c,:u,'joined','',:s,:t)`, { id, c: c.id, u: me.id, s: 'sent', t });
      run('UPDATE convos SET last=:t WHERE id=:c', { t, c: c.id });
      broadcast(c, one('SELECT * FROM messages WHERE id=:id', { id }));
    }
    return { convo: convoOut(convoOf(c.id, me.id), me) };
  });
  r('DELETE', '/api/convos/([\\w-]+)/members/me', false, ({ me, m }) => {
    const c = convoOf(m[1], me.id);
    if (isAgent(me)) fail(403, 'only you can leave a conversation');
    run('DELETE FROM convo_members WHERE convo_id=:c AND user_id=:u', { c: c.id, u: me.id });
    setAgent(c.id, me.id, false);
    if (!memberIds(c.id).length) run('DELETE FROM convos WHERE id=:id', { id: c.id });
    return { ok: true };
  });

  r('POST', '/api/convos/([\\w-]+)/messages', false, ({ me, m, body }) => {
    const c = convoOf(m[1], me.id), agent = isAgent(me);
    const kind = String(body.kind || 'chat');
    if (!KINDS.includes(kind)) fail(400, `kind must be one of ${KINDS.join(', ')}`);
    const text = String(body.text || '').trim().slice(0, 20000);
    let data = null;
    if (kind === 'skill') {
      const ref = String(body.skill || '').replace(/^@/, '') || fail(400, 'say which skill to share, like acme/handbook');
      const [owner, name] = ref.includes('/') ? ref.split('/') : [null, ref];
      const s = one(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE ${VISIBLE} AND (s.id=:ref OR (s.name=:n AND (:o IS NULL OR coalesce(u.handle, o.slug)=:o)))`, { u: me.id, ref, n: name, o: owner })
        || fail(404, `no skill ${ref} that you can see`);
      const blind = memberIds(c.id).filter((u) => !one(`SELECT 1 x FROM ${SKILL_FROM} WHERE s.id=:id AND ${VISIBLE}`, { id: s.id, u }));
      if (blind.length) fail(403, `${s.owner}/${s.name} is ${s.visibility}: not everyone here can see it. Make it public or friends-only first.`);
      data = { skill: { id: s.id, ref: `${s.owner}/${s.name}`, description: s.description, version: s.version } };
    } else if (!text) fail(400, 'write something');
    let status = 'sent';
    if (agent) {
      if (!agentsOn(c)[me.id]) fail(403, 'your agent is turned off in this conversation; its owner can turn it on');
      const may = mode(me.id, c.id, 'out', kind);
      if (may === 'never') fail(403, `your owner does not let you send "${KIND_LABELS[kind]}" here; say so to the people in the chat or ask your owner`);
      // Loop guard: agents cannot talk among themselves forever without a person.
      const lastHuman = one(`SELECT max(created) t FROM messages WHERE convo_id=:c AND agent IS NULL AND kind!='joined'`, { c: c.id }).t || 0;
      if (one(`SELECT count(*) n FROM messages WHERE convo_id=:c AND agent IS NOT NULL AND status='sent' AND created>:t`, { c: c.id, t: lastHuman }).n >= AGENT_RUN)
        fail(429, `agents have sent ${AGENT_RUN} messages here without a person replying; wait for one`);
      if (may === 'ask') status = 'held';
    }
    const id = rid(9), t = Math.max(now(), (one('SELECT max(created) t FROM messages WHERE convo_id=:c', { c: c.id }).t || 0) + 1);
    run('INSERT INTO messages(id,convo_id,user_id,agent,kind,text,data,status,created) VALUES(:id,:c,:u,:a,:k,:x,:d,:s,:t)',
      { id, c: c.id, u: me.id, a: agent ? me.tlabel : null, k: kind, x: text, d: data && JSON.stringify(data), s: status, t });
    if (status === 'sent') run('UPDATE convos SET last=:t WHERE id=:c', { t, c: c.id });
    if (!agent) run('UPDATE convo_members SET read=:t WHERE convo_id=:c AND user_id=:u', { t, c: c.id, u: me.id });
    const msg = one('SELECT * FROM messages WHERE id=:id', { id });
    broadcast(c, msg);
    return { message: msgOut(msg), note: status === 'held' ? 'held for your owner to approve before anyone else sees it' : undefined };
  });
  // Your agent's held messages: approve sends it, decline keeps it from everyone (it stays in your own history).
  const heldMsg = (id, me) => {
    if (isAgent(me)) fail(403, 'only the person can approve what their agent says');
    return one(`SELECT * FROM messages WHERE id=:id AND user_id=:u AND status='held'`, { id, u: me.id }) || fail(404, 'no held message with that id');
  };
  r('POST', '/api/messages/([\\w-]+)/approve', false, ({ me, m, body }) => {
    const x = heldMsg(m[1], me), t = now();
    const text = body.text !== undefined ? String(body.text).trim().slice(0, 20000) || x.text : x.text;
    run(`UPDATE messages SET status='sent', text=:x, created=:t WHERE id=:id`, { id: x.id, x: text, t });
    run('UPDATE convos SET last=:t WHERE id=:c', { t, c: x.convo_id });
    if (body.always) run('INSERT OR REPLACE INTO grants VALUES(:u,:o,\'out\',:k,\'allow\')', { u: me.id, o: x.convo_id, k: x.kind });
    const msg = one('SELECT * FROM messages WHERE id=:id', { id: x.id });
    broadcast({ id: x.convo_id }, msg);
    return { message: msgOut(msg) };
  });
  r('POST', '/api/messages/([\\w-]+)/decline', false, ({ me, m }) => {
    const x = heldMsg(m[1], me);
    run(`UPDATE messages SET status='declined' WHERE id=:id`, { id: x.id });
    broadcast({ id: x.convo_id }, one('SELECT * FROM messages WHERE id=:id', { id: x.id }));
    return { ok: true };
  });
  // Permissions: what your agent may send ("out") and what it is shown ("in"), for one conversation or as your default ('*').
  r('GET', '/api/permissions', false, ({ me, query }) => {
    const cid = query.get('convo') || '*';
    if (cid !== '*') convoOf(cid, me.id);
    return { convo: cid, permissions: grantsFor(me.id, cid), kinds: KIND_LABELS, defaults: cid === '*' ? DEFAULT_GRANTS : grantsFor(me.id, '__none__') };
  });
  r('PUT', '/api/permissions', false, ({ me, body }) => {
    if (isAgent(me)) fail(403, 'only you can change what your agent may say');
    const cid = body.convo || '*';
    if (cid !== '*') convoOf(cid, me.id);
    for (const dir of ['out', 'in']) for (const [k, v] of Object.entries(body[dir] || {})) {
      if (!KINDS.includes(k)) fail(400, `unknown kind ${k}`);
      if (v === null) { run('DELETE FROM grants WHERE owner=:u AND other=:o AND dir=:d AND kind=:k', { u: me.id, o: cid, d: dir, k }); continue; }
      if (!(dir === 'out' ? ['allow', 'ask', 'never'] : ['allow', 'never']).includes(v)) fail(400, `${dir} ${k} must be ${dir === 'out' ? 'allow, ask or never' : 'allow or never'}`);
      run('INSERT OR REPLACE INTO grants VALUES(:u,:o,:d,:k,:v)', { u: me.id, o: cid, d: dir, k, v });
    }
    return { convo: cid, permissions: grantsFor(me.id, cid) };
  });
  // What this user's machines should have: installed skills they can still see, plus every required skill of their organizations,
  // plus the built-in skillnet guide.
  const manifest = (u) => [
    ...all(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE s.version>0 AND (
        (s.id IN (SELECT skill_id FROM installs WHERE user_id=:u) AND ${VISIBLE})
        OR (s.required=1 AND s.owner_org IN (SELECT org_id FROM members WHERE user_id=:u))) ORDER BY s.name`, { u })
      .map((s) => ({ id: s.id, owner: s.owner, name: s.name, version: s.version, hash: s.hash, required: !!s.required, description: s.description })),
    { id: GUIDE_ID, owner: 'skillnet', name: 'skillnet', version: 1, hash: bundleHash(guideFiles(baseUrl)), required: true, builtin: true,
      description: 'How to find, use, share and change skills on Rucksack, and who may change what.' },
  ];
  r('GET', '/api/manifest', false, ({ me }) => ({ skills: manifest(me.id) }));
  const bundleOf = (id, u) => {
    if (id === GUIDE_ID) { const files = guideFiles(baseUrl); return { id, name: 'skillnet', hash: bundleHash(files), version: 1, files }; }
    const s = visibleSkill(id, u);
    const v = one('SELECT bundle FROM versions WHERE skill_id=:s AND version=:v', { s: s.id, v: s.version }) || fail(404, 'skill has no versions');
    return { id: s.id, name: s.name, hash: s.hash, version: s.version, files: JSON.parse(v.bundle) };
  };

  // One shell script that writes this person's skills into the agent folders: for cloud runs with only sh, curl and base64.
  //   curl -fsSL -H "Authorization: Bearer $SKILLNET_KEY" <server>/api/pull.sh | sh
  r('GET', '/api/pull.sh', false, ({ me, res }) => {
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const lines = [`#!/bin/sh`, `# Rucksack: skills for @${me.handle} from ${baseUrl}. Set SKILLNET_DIRS to choose folders.`, `set -e`,
      `dirs="$SKILLNET_DIRS"`,
      `if [ -z "$dirs" ]; then for d in .claude/skills .pi/agent/skills .codex/skills .agents/skills .cursor/skills .gemini/skills; do`,
      `  [ -d "$HOME/\${d%/skills}" ] && dirs="$dirs $HOME/$d"; done; fi`,
      `[ -n "$dirs" ] || dirs="$HOME/.claude/skills $HOME/.agents/skills"`,
      `dec() { base64 -d 2>/dev/null || base64 -D; }`,
      `n=0`, `for t in $dirs; do mkdir -p "$t"`];
    for (const s of manifest(me.id)) {
      const b = bundleOf(s.id, me.id);
      const marker = JSON.stringify({ id: s.id, owner: s.owner, name: s.name, hash: b.hash, version: b.version, server: baseUrl, source: false });
      lines.push(`d="$t/${s.name}"`,
        `if [ -e "$d" ] && [ ! -f "$d/.skillnet.json" ]; then echo "skillnet: kept your own $d"; else rm -rf "$d"`);
      for (const [p, data] of Object.entries(b.files)) {
        lines.push(`mkdir -p "$(dirname "$d/"${q(p)})"`, `printf %s ${q(data)} | dec > "$d/"${q(p)}`);
        if (Buffer.from(data, 'base64').subarray(0, 2).toString() === '#!') lines.push(`chmod +x "$d/"${q(p)}`);
      }
      lines.push(`printf %s ${q(marker)} > "$d/.skillnet.json"`, `n=$((n+1)); fi`);
    }
    lines.push(`done`, `echo "skillnet: ${manifest(me.id).length} skills written to:$dirs"`, '');
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' }).end(lines.join('\n'));
  });
  const listen = ({ me, req, res }, mcp) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (mcp) { res.mcp = true; res.flushHeaders(); } else res.write(`event: hello\ndata: {}\n\n`);
    res.human = !mcp && me.tkind === 'web';
    if (!streams.has(me.id)) streams.set(me.id, new Set());
    streams.get(me.id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => { clearInterval(ping); streams.get(me.id)?.delete(res); });
    return undefined; // stays open
  };
  r('GET', '/api/events', false, (x) => listen(x));
  // MCP's server-to-app stream (GET on the MCP address).
  r('GET', '/api/mcp', false, (x) => listen(x, true));

  // MCP over streamable HTTP (JSON responses), for agents that take tools instead of skill folders.
  // Each tool is a call to the API above, as the key's owner.
  const call = async (me, method, p, body = {}) => {
    const url = new URL(p, 'http://x');
    const route = routes.find(([m, re]) => m === method && re.test(url.pathname));
    if (me.scope === 'read' && method !== 'GET') fail(403, 'this API key is read-only; make a write key to publish');
    return route[3]({ me, body, m: url.pathname.match(route[1]), query: url.searchParams });
  };
  const resolve = async (me, ref) => (await call(me, 'GET', `/api/resolve?ref=${encodeURIComponent(ref)}`)).skill;
  const fileMap = (a) => Object.fromEntries(Object.entries(a.files || {}).map(([p, t]) => [p, Buffer.from(t).toString('base64')]));
  const brief = (s) => `${s.owner}/${s.name} (v${s.version}, ${s.visibility}${s.required ? ', required' : ''}${s.can_edit ? ', you can edit' : ''}): ${s.description}`;
  const str = (d) => ({ type: 'string', description: d });
  const TOOLS = [
    ['search_skills', 'Find shared skills you can see (yours, friends\', your organizations\', public) by words in their name, description or text.',
      { query: str('words to look for; empty lists everything') }, [],
      async (me, a) => (await call(me, 'GET', `/api/skills?q=${encodeURIComponent(a.query || '')}`)).skills.map(brief).join('\n') || 'No skills match.'],
    ['read_skill', 'Read a skill: its SKILL.md (default) or another file in it.',
      { skill: str('owner/name, like acme/handbook'), path: str('file inside the skill, default SKILL.md') }, ['skill'],
      async (me, a) => (await call(me, 'GET', `/api/skills/${(await resolve(me, a.skill)).id}/file?path=${encodeURIComponent(a.path || 'SKILL.md')}`)).text],
    ['skill_info', 'Who owns a skill, who can see it, whether it is required, its version history and open suggested changes.',
      { skill: str('owner/name') }, ['skill'],
      async (me, a) => {
        const s = await resolve(me, a.skill), d = await call(me, 'GET', `/api/skills/${s.id}`);
        const props = (await call(me, 'GET', `/api/proposals?skill=${s.id}`)).proposals;
        return [brief(d.skill), `Files: ${d.files.map((f) => f.path).join(', ')}`,
          `You can ${d.skill.can_edit ? 'edit it' : 'suggest changes to it'}${d.skill.can_manage ? ' and decide who gets it' : ''}.`,
          'Versions:', ...d.versions.map((v) => `  v${v.version} by @${v.author} ${new Date(v.created).toISOString().slice(0, 10)} ${v.note}`),
          ...(props.length ? ['Open suggestions:', ...props.map((p) => `  ${p.id} by @${p.author}: ${p.note}`)] : [])].join('\n');
      }],
    ['my_account', 'Who you are signed in as, your organizations and role in each (owner, admin, editor, member), friends, and the skills your machines get.',
      {}, [],
      async (me) => {
        const m = await call(me, 'GET', '/api/me'), f = await call(me, 'GET', '/api/friends');
        return [`@${m.user.handle} (${m.user.name}), key scope: ${me.scope}`,
          `Organizations: ${m.orgs.map((o) => `${o.slug} (${o.role})`).join(', ') || 'none'}`,
          `Friends: ${f.friends.map((u) => `@${u.handle}`).join(', ') || 'none'}`,
          `Skills on your machines: ${manifest(me.id).map((s) => `${s.owner}/${s.name}`).join(', ')}`,
          'Roles: editors change what organization skills say; admins also decide who gets them (required/optional, visibility) and manage people; members use skills and suggest changes.'].join('\n');
      }],
    ['publish_skill', 'Publish a new skill or a new version of one you can edit. Needs a write key. Members without edit rights should use suggest_change.',
      { name: str('lowercase-name'), files: { type: 'object', additionalProperties: { type: 'string' }, description: 'path -> text; must include SKILL.md' },
        org: str('organization id to publish under; omit for a personal skill'), visibility: str('private, friends or public (personal); org or public (organization)'),
        required: { type: 'boolean', description: 'organization only: put it on every member\'s machines' }, note: str('what changed') }, ['name', 'files'],
      async (me, a) => { const r = await call(me, 'POST', '/api/skills/push', { ...a, files: fileMap(a) }); return `${r.changed ? 'Published' : 'No changes to'} ${brief(r.skill)}`; }],
    ['suggest_change', 'Suggest new files for a skill you cannot edit; an editor approves or declines it. Files you leave out stay as they are.',
      { skill: str('owner/name'), files: { type: 'object', additionalProperties: { type: 'string' }, description: 'path -> new text' }, note: str('why') }, ['skill', 'files'],
      async (me, a) => {
        const s = await resolve(me, a.skill), cur = (await call(me, 'GET', `/api/skills/${s.id}/bundle`)).files;
        const r = await call(me, 'POST', `/api/skills/${s.id}/proposals`, { files: { ...cur, ...fileMap(a) }, note: a.note });
        return `Suggested change ${r.proposal.id} sent to the editors of ${r.proposal.skill}.`;
      }],
    ['list_changes', 'Open change requests (suggested changes and git branches) on skills you can edit or that you sent, with approvals so far and what changed.',
      { skill: str('owner/name; omit for all') }, [],
      async (me, a) => {
        const sid = a.skill ? (await resolve(me, a.skill)).id : '';
        const ps = (await call(me, 'GET', `/api/proposals${sid ? `?skill=${sid}` : ''}`)).proposals;
        return ps.map((p) => `${p.id}  ${p.skill}${p.new_skill ? ' (new skill)' : ''} by @${p.author}${p.branch ? ` from branch ${p.branch}` : ''}: ${p.note || '(no note)'}\n`
          + `  changed: ${p.changed.join(', ')}; approvals ${p.approvals.length} of ${p.needs}${p.approvals.length ? ` (${p.approvals.map((h) => `@${h}`).join(', ')})` : ''}`
          + `${p.conflicts.length ? `; CONFLICTS in ${p.conflicts.join(', ')}` : ''}${p.can_approve ? '; you can approve' : ''}\n  proposed SKILL.md:\n${p.skill_md.replace(/^/gm, '    ')}`).join('\n\n') || 'No open change requests.';
      }],
    ['review_change', 'Approve or decline a change request. Only do this when your owner told you to; approving merges it once it has enough approvals.',
      { id: str('change request id from list_changes'), decision: str('approve or decline') }, ['id', 'decision'],
      async (me, a) => {
        if (a.decision === 'decline') { await call(me, 'POST', `/api/proposals/${a.id}/decline`); return 'Declined.'; }
        const r = await call(me, 'POST', `/api/proposals/${a.id}/approve`);
        return r.merged ? `Approved and merged: ${brief(r.skill)}` : `Approved (${r.approvals} of ${r.needs}); it merges when enough editors approve.`;
      }],
    ['list_services', 'Services your organizations connected to Rucksack (APIs whose keys Rucksack holds) and what you may do with each: none, read, ask (changes wait for an admin) or write.',
      {}, [],
      async (me) => access.mine(me.id).map((c) => `${c.org}/${c.name}: ${c.description || c.base_url} (base ${c.base_url}); you: ${c.my_level}`).join('\n') || 'No connected services.'],
    ['call_service', 'Call a connected service through Rucksack, which adds the key. Paths are relative to the service base address. Reads (GET) go through if you have read access; other methods need write, or wait for an admin with ask.',
      { service: str('org/name from list_services'), method: str('GET, POST, PUT, PATCH, DELETE'), path: str('path under the base address, with any ?query'),
        body: { description: 'JSON body for POST, PUT, PATCH' }, reason: str('why, shown to the admin who approves it') }, ['service', 'path'],
      async (me, a) => {
        const [org, name] = String(a.service).split('/');
        const r = await call(me, 'POST', `/api/orgs/${org}/connections/${name}/call`, { method: a.method, path: a.path, body: a.body, reason: a.reason });
        return r.status === 'waiting' ? `${r.message} Request id ${r.id}; check it later with check_service_request.` : `HTTP ${r.http}\n${r.result}`;
      }],
    ['check_service_request', 'See whether a service call that was waiting for approval went through, and its result.',
      { id: str('request id') }, ['id'],
      async (me, a) => { const x = (await call(me, 'GET', `/api/access-requests/${a.id}`)).request; return `${x.method} ${x.path}: ${x.status}${x.decided_by ? ` by @${x.decided_by}` : ''}${x.http != null ? `\nHTTP ${x.http}\n${x.result}` : ''}`; }],
    ['list_conversations', 'Chats you are in (direct and group, with people and their agents), whether you (the agent) take part in each, and unread counts.',
      {}, [],
      async (me) => (await call(me, 'GET', '/api/convos')).convos.map((c) => `${c.id}  ${c.kind === 'dm' ? `with ${c.name}` : `group "${c.name}"`}  ${c.members.map((x) => `@${x.handle}${x.agent ? '+agent' : ''}`).join(' ')}  ${c.my_agent ? 'you take part' : 'you are off here'}${c.unread ? `, ${c.unread} unread` : ''}`).join('\n') || 'No conversations yet.'],
    ['read_conversation', 'Read recent messages in a conversation, plus what your owner lets you send there.',
      { conversation: str('@handle for a direct chat, a group name, or an id'), since: { type: 'number', description: 'only messages after this time (ms)' } }, ['conversation'],
      async (me, a) => {
        const c = (await call(me, 'GET', `/api/convos/resolve?ref=${encodeURIComponent(a.conversation)}`)).convo;
        const d = await call(me, 'GET', `/api/convos/${c.id}?since=${a.since || 0}`);
        return [`${d.convo.kind === 'dm' ? `Direct with ${d.convo.name}` : `Group "${d.convo.name}"`} (${c.id})`, permText(d.permissions), '',
          ...d.messages.map(msgText)].join('\n');
      }],
    ['send_message', 'Send a message to a conversation as your owner\'s agent. Label it honestly with its kind; your owner decides per kind whether it goes straight out, waits for their approval, or is not allowed.',
      { conversation: str('@handle, group name or id'), text: str('the message'), kind: str(`one of ${KINDS.join(', ')}: chat (talk, answers), question, task (asking someone to do work), skill (share one; give skill), personal (anything about your owner: calendar, contacts, files, places)`),
        skill: str('for kind skill: owner/name') }, ['conversation'],
      async (me, a) => {
        const c = (await call(me, 'GET', `/api/convos/resolve?ref=${encodeURIComponent(a.conversation)}`)).convo;
        const r = await call(me, 'POST', `/api/convos/${c.id}/messages`, a);
        return r.message.status === 'held' ? `Held: your owner approves "${r.message.kind}" messages before they go out. Tell them it is waiting.` : `Sent (${r.message.id}).`;
      }],
  ];
  // Plain-text forms shared by the MCP tools and the command line.
  const MODE_WORDS = { allow: 'yes', ask: 'after your owner approves', never: 'no' };
  const permText = (p) => `You may send here: ${KINDS.map((k) => `${k} ${MODE_WORDS[p.out[k]]}`).join('; ')}. You are shown: ${KINDS.filter((k) => p.in[k] === 'allow').join(', ')}.`;
  const msgText = (m) => `[${new Date(m.created).toISOString().slice(0, 16).replace('T', ' ')}] ${m.agent ? `@${m.from.handle}'s agent` : `@${m.from.handle}`}${m.kind === 'chat' ? '' : ` (${m.kind})`}${m.status === 'sent' ? '' : ` [${m.status}]`}: ${m.kind === 'joined' ? 'joined' : m.kind === 'skill' ? `shared skill ${m.data.skill.ref}: ${m.data.skill.description} ${m.text}` : m.text}`;
  // The person's skill list goes in the server instructions, which agents load at session start (like native skills: name and when to
  // use it up front, full text on demand through read_skill). Clients cut instructions at 4,096 characters.
  const instructions = (me, local) => {
    if (local) return `Rucksack holds the shared skills of @${me.handle}. They are installed on this machine as skill files by the Rucksack plugin and load like any other skill. `
      + `This connector adds search_skills (skills not installed), conversations with people and other agents (list_conversations, read_conversation, send_message; stay within what your owner allows) `
      + `and shared services (list_services, call_service). For questions about sharing or changing skills, use the skillnet skill.`;
    const head = `Rucksack holds the shared skills of @${me.handle} and their conversations with people and other agents (list_conversations, read_conversation, send_message; stay within what your owner allows). Each line below is a skill and when to use it. When a task matches one, `
      + `call read_skill with its name first and follow it; read other files it mentions with read_skill and path. `
      + `Use search_skills for skills not listed. For questions about sharing or changing skills, or chatting, read skillnet/skillnet.\n\nSkills:\n`;
    let out = head;
    for (const s of manifest(me.id)) {
      const line = `- ${s.owner}/${s.name}: ${(s.description || '').replace(/\s+/g, ' ')}\n`;
      if (out.length + line.length > 4000) { out += '- (more: use search_skills)\n'; break; }
      out += line;
    }
    return out;
  };
  // Each skill is also a prompt, so it shows as a command (/mcp__skillnet__name in Claude Code).
  const promptList = (me) => {
    const seen = new Set();
    return manifest(me.id).map((s) => {
      const name = seen.has(s.name) ? `${s.owner}-${s.name}` : s.name;
      seen.add(s.name);
      return { name, title: `${s.owner}/${s.name}`, description: s.description, id: s.id };
    });
  };
  // The Claude Code plugin sends X-Rucksack-Files: 1. Once a machine of this person syncs files (a recent sign-in from the command-line tool),
  // the skill list and prompts are left out so the agent does not see every skill twice.
  // shortcut: any of the person's machines counts, not this one; tie the connector to its machine if that misleads.
  const syncsFiles = (req, me) => req.headers['x-rucksack-files'] === '1'
    && !!one(`SELECT 1 x FROM tokens WHERE user_id=:u AND kind='cli' AND used>:t`, { u: me.id, t: now() - 30 * 864e5 });
  r('POST', '/api/mcp', false, async ({ me, body, res, req }) => {
    const reply = (result) => ({ jsonrpc: '2.0', id: body.id, result });
    const local = syncsFiles(req, me);
    if (body.id === undefined) { res.writeHead(202).end(); return undefined; } // notifications
    if (body.method === 'initialize') return reply({ protocolVersion: body.params?.protocolVersion || '2025-06-18', capabilities: { tools: {}, prompts: { listChanged: true } },
      serverInfo: { name: 'rucksack', version: '1' }, instructions: instructions(me, local) });
    if (body.method === 'ping') return reply({});
    if (body.method === 'prompts/list') return reply({ prompts: local ? [] : promptList(me).map(({ id, ...p }) => ({ ...p,
      arguments: [{ name: 'request', description: 'what you want done', required: false }] })) });
    if (body.method === 'prompts/get') {
      const p = promptList(me).find((x) => x.name === body.params?.name);
      if (!p) return { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `unknown prompt ${body.params?.name}` } };
      const md = Buffer.from(bundleOf(p.id, me.id).files['SKILL.md'], 'base64').toString('utf8');
      const ask = body.params.arguments?.request;
      return reply({ description: p.description, messages: [{ role: 'user', content: { type: 'text',
        text: `Use the skill ${p.title} (other files in it: read_skill with path).\n\n${md}${ask ? `\n\nRequest: ${ask}` : ''}` } }] });
    }
    if (body.method === 'tools/list') return reply({ tools: TOOLS.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } })) });
    if (body.method === 'tools/call') {
      const tool = TOOLS.find((t) => t[0] === body.params?.name);
      if (!tool) return { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `unknown tool ${body.params?.name}` } };
      try { return reply({ content: [{ type: 'text', text: await tool[4](me, body.params.arguments || {}) }] }); }
      catch (e) { if (!e.status) throw e; return reply({ content: [{ type: 'text', text: e.message }], isError: true }); }
    }
    return { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `unknown method ${body.method}` } };
  });

  function setCookie(res, token) {
    const secure = baseUrl.startsWith('https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sn=${token}; Path=/; Max-Age=${60 * 60 * 24 * 90}; HttpOnly; SameSite=Lax${secure}`);
  }

  const installScript = () => `#!/bin/sh
# Installs the skillnet command in ~/.local/share/skillnet and signs this machine in to ${baseUrl}
set -e
command -v node >/dev/null || { echo "skillnet needs Node 22 or newer: https://nodejs.org"; exit 1; }
D="$HOME/.local/share/skillnet"; mkdir -p "$D" "$HOME/.local/bin"
curl -fsSL ${baseUrl}/cli/skillnet.js -o "$D/skillnet.js"
curl -fsSL ${baseUrl}/cli/pi-skillnet-reload.ts -o "$D/pi-skillnet-reload.ts"
chmod +x "$D/skillnet.js"; ln -sf "$D/skillnet.js" "$HOME/.local/bin/skillnet"
node "$D/skillnet.js" setup ${baseUrl} </dev/tty
echo "Done. Add ~/.local/bin to your PATH if 'skillnet' is not found."
`;

  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.sh': 'text/plain; charset=utf-8' };
  const assetHash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, f))).digest('hex').slice(0, 10);
  function serveStatic(url, res) {
    let file = path.normalize(path.join(PUBLIC, url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    // no-cache: the Cloudflare edge would otherwise keep serving the old app.js after a deploy.
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    // Asset links carry a content hash, so phones holding an old copy fetch the new one.
    if (file.endsWith('index.html')) return res.end(fs.readFileSync(file, 'utf8').replace(/(href|src)="\/(\w+\.(?:css|js))"/g, (m, a, f) => `${a}="/${f}?v=${assetHash(f)}"`));
    fs.createReadStream(file).pipe(res);
  }

  const access = accessApi({ r, one, all, run, getOrg, role, isAdmin, rid, now, fail, secretKey, allowPrivate, emit });
  const mirror = gitDir && gitMirror({ gitDir, baseUrl, one, all, run, getOrg, role, isEditor, isAdmin, pushSkill, deleteSkill, propose, closeProposal,
    frontmatter, rid, now, hooks, NAME_RE });
  if (gitDir) fs.mkdirSync(gitDir, { recursive: true });
  const pluginRepo = gitDir && buildPluginRepo(gitDir, baseUrl, fs.readFileSync(path.join(HERE, 'cli', 'skillnet.js'), 'utf8'));

  const readBody = async (req) => {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX_BUNDLE * 1.5) fail(413, 'request too large'); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  };
  const json = (res, status, out, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(out));
  const MCP_URL = () => `${baseUrl}/mcp`;
  const RESOURCE_META = () => `${baseUrl}/.well-known/oauth-protected-resource/mcp`;
  const ACCESS_TTL = 3600e3;

  // OAuth endpoints that MCP clients call themselves: discovery, app registration and the token exchange. Plain JSON or form bodies,
  // reachable from any origin (no cookies are read here).
  async function oauth(req, res, url) {
    const p = url.pathname;
    const asMeta = { issuer: baseUrl, authorization_endpoint: `${baseUrl}/oauth/authorize`, token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`, revocation_endpoint: `${baseUrl}/oauth/revoke`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['read', 'write'] };
    if (p.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, { resource: MCP_URL(), authorization_servers: [baseUrl], scopes_supported: ['read', 'write'], bearer_methods_supported: ['header'] });
    if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration')) return json(res, 200, asMeta);
    if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' }, { Allow: 'POST' });
    const text = await readBody(req);
    let b = {};
    try { b = (req.headers['content-type'] || '').startsWith('application/json') ? JSON.parse(text || '{}') : Object.fromEntries(new URLSearchParams(text)); }
    catch { return json(res, 400, { error: 'invalid_request', error_description: 'bad body' }); }
    const bad = (error, error_description, status = 400) => json(res, status, { error, error_description });

    if (p === '/oauth/register') {
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
      const safe = (u) => { try { const x = new URL(u); return !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(x.protocol) && !x.hash
        && (x.protocol !== 'http:' || LOOPBACK.includes(x.hostname)); } catch { return false; } };
      if (!uris.length || uris.length > 10 || !uris.every(safe)) return bad('invalid_redirect_uri', 'redirect_uris must be https, a loopback http address or an app link');
      const id = `snc_${rid(12)}`, name = String(b.client_name || 'An MCP app').slice(0, 80);
      run('INSERT INTO oauth_clients VALUES(:id,:n,:r,:t)', { id, n: name, r: JSON.stringify(uris), t: now() });
      return json(res, 201, { client_id: id, client_name: name, redirect_uris: uris, client_id_issued_at: Math.floor(now() / 1000),
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    }
    if (p === '/oauth/revoke') {
      const h = sha(String(b.token || ''));
      const t = one('SELECT id, kind, grant_id FROM tokens WHERE hash=:h AND kind IN (\'oauth\',\'connector\')', { h });
      if (t) run('DELETE FROM tokens WHERE id=:g OR grant_id=:g', { g: t.kind === 'connector' ? t.id : t.grant_id });
      return json(res, 200, {});
    }
    if (p !== '/oauth/token') return bad('invalid_request', 'not found', 404);

    let grant;
    if (b.grant_type === 'authorization_code') {
      const c = one('SELECT * FROM oauth_codes WHERE hash=:h', { h: sha(String(b.code || '')) });
      if (c) run('DELETE FROM oauth_codes WHERE hash=:h', { h: c.hash }); // single use
      run('DELETE FROM oauth_codes WHERE created<:t', { t: now() - 10 * 60e3 });
      if (!c || now() - c.created > 10 * 60e3 || c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) return bad('invalid_grant', 'code is wrong, used or expired');
      if (crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url') !== c.challenge) return bad('invalid_grant', 'PKCE check failed');
      const client = getClient(c.client_id);
      grant = { id: rid(8), user: c.user_id, scope: c.scope };
      run(`INSERT INTO tokens(id,hash,user_id,kind,label,created,scope,client) VALUES(:id,'pending-' || :id,:u,'connector',:l,:c,:s,:cl)`,
        { id: grant.id, u: c.user_id, l: client.name, c: now(), s: c.scope, cl: client.id });
    } else if (b.grant_type === 'refresh_token') {
      const t = one(`SELECT * FROM tokens WHERE hash=:h AND kind='connector'`, { h: sha(String(b.refresh_token || '')) });
      if (!t || (b.client_id && t.client !== b.client_id)) return bad('invalid_grant', 'sign in again');
      grant = { id: t.id, user: t.user_id, scope: t.scope };
    } else return bad('unsupported_grant_type', 'use authorization_code or refresh_token');

    // Rotate: new refresh token on the same grant row, old access tokens of this grant end.
    const refresh = `snr_${rid(32)}`, access = `sn_${rid(32)}`;
    run('UPDATE tokens SET hash=:h WHERE id=:id', { h: sha(refresh), id: grant.id });
    run(`DELETE FROM tokens WHERE grant_id=:g OR (kind='oauth' AND expires<:n)`, { g: grant.id, n: now() });
    run(`INSERT INTO tokens(id,hash,user_id,kind,label,created,scope,expires,grant_id) VALUES(:id,:h,:u,'oauth','access',:c,:s,:e,:g)`,
      { id: rid(8), h: sha(access), u: grant.user, c: now(), s: grant.scope, e: now() + ACCESS_TTL, g: grant.id });
    return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: grant.scope });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    // Old addresses (SKILLNET_REDIRECT_HOSTS): send browsers to the current one; API, MCP and OAuth calls keep working there.
    if (redirectHosts.includes(req.headers.host) && req.method === 'GET' && (req.headers.accept || '').includes('text/html'))
      return res.writeHead(301, { Location: baseUrl + url.pathname + url.search }).end();
    const isMcp = url.pathname === '/mcp' || url.pathname === '/api/mcp';
    const machine = isMcp || url.pathname.startsWith('/.well-known/') || ['/oauth/token', '/oauth/register', '/oauth/revoke'].includes(url.pathname);
    if (machine) {
      // Any origin may call these with a bearer token; cookies are never read on them.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
      if (req.method === 'OPTIONS') return res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, X-Rucksack-Files', 'Access-Control-Max-Age': '86400' }).end();
      if (!isMcp) { try { return await oauth(req, res, url); } catch (e) { return json(res, e.status || 500, { error: 'invalid_request', error_description: e.status ? e.message : 'server error' }); } }
      if (req.method === 'GET' && !(req.headers.accept || '').includes('text/event-stream')) return res.writeHead(405, { Allow: 'GET, POST' }).end();
      if (!['GET', 'POST'].includes(req.method)) return res.writeHead(405, { Allow: 'GET, POST' }).end();
    }
    if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') return stripeWebhook(req, res);
    if (mirror && url.pathname === '/internal/git-hook' && req.method === 'POST') return mirror.hookRoute(req, res, readBody);
    if (mirror && url.pathname.startsWith('/git/')) return mirror.serve(req, res, url, auth);
    if (url.pathname === '/install.sh') return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(installScript());
    const cli = /^\/cli\/(skillnet\.js|pi-skillnet-reload\.ts)$/.exec(url.pathname)?.[1];
    if (cli) return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(path.join(HERE, 'cli', cli)));
    if (url.pathname.startsWith('/plugin.git/')) return servePlugin(pluginRepo, req, res, url);
    if (url.pathname === '/mcp') url.pathname = '/api/mcp';
    if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);
    try {
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) fail(404, 'not found');
      const [, re, open, fn] = route;
      const me = auth(req, isMcp);
      if (isMcp && !me) res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${RESOURCE_META()}"`);
      if (!open && !me) fail(401, 'sign in first');
      if (me?.scope === 'read' && req.method !== 'GET' && url.pathname !== '/api/mcp') fail(403, 'this API key is read-only; make a write key to publish');
      let body = {};
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        // JSON-only bodies: browsers cannot send these cross-site without a preflight, which blocks cookie-riding requests.
        if (req.headers['content-length'] !== '0' && req.headers['content-type'] && !req.headers['content-type'].startsWith('application/json')) fail(415, 'send JSON');
        const text = await readBody(req);
        try { body = text ? JSON.parse(text) : {}; } catch { fail(400, 'bad JSON'); }
      }
      const out = await fn({ me, body, m: url.pathname.match(re), req, res, query: url.searchParams });
      if (out === undefined) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'server error' : e.message }));
    }
  }
  return { handle, streams };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8795);
  const db = openDb(process.env.SKILLNET_DB || path.join(HERE, 'data', 'skillnet.db'));
  const e = process.env;
  const billing = e.STRIPE_KEY && e.STRIPE_PRICE && e.STRIPE_WEBHOOK_SECRET
    ? { stripe: stripeClient(e.STRIPE_KEY), price: e.STRIPE_PRICE, webhookSecret: e.STRIPE_WEBHOOK_SECRET, priceLabel: e.STRIPE_PRICE_LABEL || null } : null;
  const app = createApp({ db, baseUrl: e.SKILLNET_URL || `http://localhost:${port}`, billing, secretKey: e.SKILLNET_SECRET_KEY || null,
    gitDir: e.SKILLNET_GIT_DIR || path.join(path.dirname(e.SKILLNET_DB || path.join(HERE, 'data', 'x')), 'git'),
    redirectHosts: (e.SKILLNET_REDIRECT_HOSTS || '').split(',').filter(Boolean) });
  http.createServer(app.handle).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`skillnet on :${port}`));
}
