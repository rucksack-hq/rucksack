// Skillnet server: accounts, friends, organizations, skills with versions, live push to sync clients.
// Zero dependencies: node:http + node:sqlite (Node 22.5+).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const MAX_BUNDLE = 5 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VIS_USER = ['private', 'friends', 'public'];
const VIS_ORG = ['org', 'public'];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
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
  `);
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

export function createApp({ db, baseUrl = '' }) {
  const all = (sql, p = {}) => db.prepare(sql).all(p);
  const one = (sql, p = {}) => db.prepare(sql).get(p);
  const run = (sql, p = {}) => db.prepare(sql).run(p);

  // Live push: every connected sync client of a user gets "sync" and re-reads its manifest.
  const streams = new Map(); // user_id -> Set(res)
  const notify = (userIds) => {
    for (const u of new Set(userIds)) for (const res of streams.get(u) || []) res.write(`event: sync\ndata: {}\n\n`);
  };
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
  const canEdit = (s, u) => (s.owner_user ? s.owner_user === u : isAdmin(s.owner_org, u));
  const getOrg = (slug) => one('SELECT * FROM orgs WHERE slug=:slug', { slug }) || fail(404, 'no such organization');
  const visibleSkill = (id, u) =>
    one(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE s.id=:id AND ${VISIBLE}`, { id, u }) || fail(404, 'no such skill');
  const pubSkill = (s, u) => ({
    id: s.id, owner: s.owner, owner_kind: s.owner_kind, name: s.name, description: s.description, visibility: s.visibility,
    required: !!s.required, version: s.version, hash: s.hash, updated: s.updated, can_edit: canEdit(s, u),
    installed: !!one('SELECT 1 x FROM installs WHERE user_id=:u AND skill_id=:s', { u, s: s.id }),
  });
  const userOut = (r) => r && { id: r.id, handle: r.handle, name: r.name };

  function issueToken(userId, kind, label) {
    const token = `sn_${rid(32)}`;
    run('INSERT INTO tokens VALUES(:id,:h,:u,:k,:l,:c,NULL)', { id: rid(8), h: sha(token), u: userId, k: kind, l: label, c: now() });
    return token;
  }
  function auth(req) {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    const cookie = /(?:^|;\s*)sn=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const tok = bearer || cookie;
    if (!tok) return null;
    const row = one('SELECT t.id tid, u.* FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.hash=:h', { h: sha(tok) });
    if (row) run('UPDATE tokens SET used=:n WHERE id=:id', { n: now(), id: row.tid });
    return row || null;
  }

  function pushSkill(me, b) {
    checkFiles(b.files);
    const size = Object.values(b.files).reduce((n, v) => n + v.length, 0);
    if (size > MAX_BUNDLE) fail(413, 'skill is larger than 5 MB');
    const md = Buffer.from(b.files['SKILL.md'], 'base64').toString('utf8');
    const fm = frontmatter(md);
    const name = String(b.name || fm.name || '').toLowerCase();
    if (!NAME_RE.test(name)) fail(400, 'skill name must be lowercase letters, digits and dashes');
    const description = String(b.description ?? fm.description ?? '').slice(0, 1024);
    let org = null;
    if (b.org) { org = getOrg(b.org); if (!isAdmin(org.id, me.id)) fail(403, 'only organization admins can publish its skills'); }
    const allowed = org ? VIS_ORG : VIS_USER;
    let s = one('SELECT * FROM skills WHERE coalesce(owner_user, owner_org)=:o AND name=:n', { o: org ? org.id : me.id, n: name });
    const visibility = b.visibility ?? s?.visibility ?? allowed[0];
    if (!allowed.includes(visibility)) fail(400, `visibility must be one of ${allowed.join(', ')}`);
    const hash = bundleHash(b.files);
    db.exec('BEGIN');
    try {
      if (!s) {
        const id = rid(9);
        run('INSERT INTO skills(id,owner_user,owner_org,name,description,visibility,required,updated) VALUES(:id,:ou,:oo,:n,:d,:v,:r,:t)',
          { id, ou: org ? null : me.id, oo: org ? org.id : null, n: name, d: description, v: visibility, r: org && b.required ? 1 : 0, t: now() });
        run('INSERT OR IGNORE INTO installs VALUES(:u,:s)', { u: me.id, s: id }); // authors get their skill on every machine
        s = one('SELECT * FROM skills WHERE id=:id', { id });
      }
      const changed = hash !== s.hash;
      if (changed) {
        const v = s.version + 1;
        run('INSERT INTO versions VALUES(:s,:v,:h,:b,:a,:note,:t)', { s: s.id, v, h: hash, b: JSON.stringify(b.files), a: me.id, note: String(b.note || ''), t: now() });
        run('UPDATE skills SET version=:v, hash=:h, updated=:t WHERE id=:s', { v, h: hash, t: now(), s: s.id });
      }
      run('UPDATE skills SET description=:d, visibility=:v, required=:r WHERE id=:s',
        { d: description, v: visibility, r: org ? (b.required === undefined ? s.required : b.required ? 1 : 0) : 0, s: s.id });
      db.exec('COMMIT');
      s = one(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE s.id=:id`, { id: s.id });
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
    user: userOut(me), email: me.email,
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
  r('GET', '/api/tokens', false, ({ me }) => ({ tokens: all(`SELECT id, label, created, used FROM tokens WHERE user_id=:u AND kind='cli' ORDER BY created DESC`, { u: me.id }) }));
  r('DELETE', '/api/tokens/([\\w-]+)', false, ({ me, m }) => { run('DELETE FROM tokens WHERE id=:id AND user_id=:u', { id: m[1], u: me.id }); return { ok: true }; });

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
    run('INSERT INTO orgs VALUES(:id,:s,:n,:i,:c)', { id, s: slug, n: String(body.name || slug).slice(0, 80), i: rid(12), c: now() });
    run(`INSERT INTO members VALUES(:o,:u,'owner')`, { o: id, u: me.id });
    return { org: { slug, name: body.name || slug, role: 'owner' } };
  });
  r('GET', '/api/orgs/([\\w-]+)', false, ({ me, m }) => {
    const o = getOrg(m[1]);
    const myRole = role(o.id, me.id) || fail(404, 'no such organization');
    return {
      org: { slug: o.slug, name: o.name, role: myRole, invite: ['owner', 'admin'].includes(myRole) ? `${baseUrl}/join?code=${o.invite}` : null },
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
    run(`INSERT OR IGNORE INTO members VALUES(:o,:u,'member')`, { o: o.id, u: me.id });
    notify([me.id]);
    return { org: { slug: o.slug, name: o.name } };
  });
  r('POST', '/api/orgs/([\\w-]+)/members/([\\w-]+)', false, ({ me, m, body }) => {
    const o = getOrg(m[1]);
    if (role(o.id, me.id) !== 'owner') fail(403, 'only owners can change roles');
    if (!['owner', 'admin', 'member'].includes(body.role)) fail(400, 'role must be owner, admin or member');
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
    notify([m[2]]);
    return { ok: true };
  });

  // Skills
  r('GET', '/api/skills', false, ({ me, query }) => {
    const q = `%${(query.get('q') || '').toLowerCase()}%`;
    return {
      skills: all(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE ${VISIBLE} AND s.version>0 AND (lower(s.name) LIKE :q OR lower(s.description) LIKE :q)
        ORDER BY s.updated DESC LIMIT 300`, { u: me.id, q }).map((s) => pubSkill(s, me.id)),
    };
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
  r('GET', '/api/skills/([\\w-]+)/bundle', false, ({ me, m }) => {
    const s = visibleSkill(m[1], me.id);
    const v = one('SELECT bundle FROM versions WHERE skill_id=:s AND version=:v', { s: s.id, v: s.version }) || fail(404, 'skill has no versions');
    return { id: s.id, name: s.name, hash: s.hash, version: s.version, files: JSON.parse(v.bundle) };
  });
  r('PATCH', '/api/skills/([\\w-]+)', false, ({ me, m, body }) => {
    const s = visibleSkill(m[1], me.id);
    if (!canEdit(s, me.id)) fail(403, 'you cannot change this skill');
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
    return pushSkill(me, { org: s.owner_org ? s.owner : undefined, name: s.name, description: s.description, files: JSON.parse(v.bundle), note: `rolled back to version ${body.version}` });
  });
  r('DELETE', '/api/skills/([\\w-]+)', false, ({ me, m }) => {
    const s = visibleSkill(m[1], me.id);
    if (!canEdit(s, me.id)) fail(403, 'you cannot delete this skill');
    const who = audience(s);
    run('DELETE FROM skills WHERE id=:s', { s: s.id });
    notify(who);
    return { ok: true };
  });
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

  // What this user's machines should have: installed skills they can still see, plus every required skill of their organizations.
  r('GET', '/api/manifest', false, ({ me }) => ({
    skills: all(`SELECT ${SKILL_COLS} FROM ${SKILL_FROM} WHERE s.version>0 AND (
        (s.id IN (SELECT skill_id FROM installs WHERE user_id=:u) AND ${VISIBLE})
        OR (s.required=1 AND s.owner_org IN (SELECT org_id FROM members WHERE user_id=:u))) ORDER BY s.name`, { u: me.id })
      .map((s) => ({ id: s.id, owner: s.owner, name: s.name, version: s.version, hash: s.hash, required: !!s.required })),
  }));
  r('GET', '/api/events', false, ({ me, req, res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: hello\ndata: {}\n\n`);
    if (!streams.has(me.id)) streams.set(me.id, new Set());
    streams.get(me.id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => { clearInterval(ping); streams.get(me.id)?.delete(res); });
    return undefined; // stays open
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
  function serveStatic(url, res) {
    let file = path.normalize(path.join(PUBLIC, url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/install.sh') return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(installScript());
    const cli = /^\/cli\/(skillnet\.js|pi-skillnet-reload\.ts)$/.exec(url.pathname)?.[1];
    if (cli) return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(path.join(HERE, 'cli', cli)));
    if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);
    try {
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) fail(404, 'not found');
      const [, re, open, fn] = route;
      const me = auth(req);
      if (!open && !me) fail(401, 'sign in first');
      let body = {};
      if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        // JSON-only bodies: browsers cannot send these cross-site without a preflight, which blocks cookie-riding requests.
        if (req.headers['content-length'] !== '0' && req.headers['content-type'] && !req.headers['content-type'].startsWith('application/json')) fail(415, 'send JSON');
        const chunks = []; let n = 0;
        for await (const c of req) { n += c.length; if (n > MAX_BUNDLE * 1.5) fail(413, 'request too large'); chunks.push(c); }
        const text = Buffer.concat(chunks).toString('utf8');
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
  const app = createApp({ db, baseUrl: process.env.SKILLNET_URL || `http://localhost:${port}` });
  http.createServer(app.handle).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`skillnet on :${port}`));
}
