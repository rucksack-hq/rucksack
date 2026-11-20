// Shared tool access: an organization keeps a service's key on Rucksack (encrypted, never shown again) and decides, per person,
// what that person's agent may do with it. Agents call the service through Rucksack; the key never reaches them.
//   none  - cannot use it
//   read  - GET and HEAD requests only
//   ask   - reads go through; anything else waits until an admin approves it
//   write - everything
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

export const LEVELS = ['none', 'read', 'ask', 'write'];
export const AUTH_TYPES = ['header', 'oauth2_refresh_token', 'oauth2_client_credentials', 'broker', 'google_dwd', 'query_params'];
const READ = ['GET', 'HEAD'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_RESULT = 100e3;
const HDR_RE = /^[A-Za-z0-9-]{1,60}$/;
const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export const ACCESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL, auth_header TEXT NOT NULL, secret TEXT NOT NULL, default_level TEXT NOT NULL DEFAULT 'none',
    created INTEGER NOT NULL, auth_type TEXT NOT NULL DEFAULT 'header', config TEXT NOT NULL DEFAULT '{}', UNIQUE(org_id, name));
  CREATE TABLE IF NOT EXISTS access(connection_id TEXT NOT NULL REFERENCES connections ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    level TEXT NOT NULL, PRIMARY KEY(connection_id, user_id));
  CREATE TABLE IF NOT EXISTS access_log(id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections ON DELETE CASCADE, user_id TEXT NOT NULL,
    agent INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, body TEXT, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
    http INTEGER, result TEXT, decided_by TEXT, created INTEGER NOT NULL, decided INTEGER);
`;

// Addresses a service may not live at: this machine, the private network, link-local (cloud metadata).
export function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateAddress(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

function apolloEstimate(pathname, body) {
  const args = (body && typeof body === 'object' ? body : {}) || {};
  const on = (k) => ['true', '1'].includes(String(args[k] ?? '').toLowerCase());
  const per = () => 1 + (on('run_waterfall_phone') ? 45 : on('reveal_phone_number') ? 8 : 0) + (on('run_waterfall_email') ? 20 : 0);
  const count = (k) => (Array.isArray(args[k]) && args[k].length ? args[k].length : 1);
  if (/(?:^|\/)people\/bulk_match\/?$/.test(pathname)) return count('details') * per();
  if (/(?:^|\/)people\/match\/?$/.test(pathname)) return per();
  if (/(?:^|\/)organizations\/bulk_enrich\/?$/.test(pathname)) return count('domains');
  if (/(?:^|\/)organizations\/enrich\/?$/.test(pathname)) return 1;
  return 0;
}

export function accessApi({ r, one, all, run, getOrg, role, isAdmin, rid, now, fail, secretKey, allowPrivate, emit }) {
  const key = secretKey && crypto.createHash('sha256').update(secretKey).digest();
  const need = () => key || fail(503, 'shared tool access is not set up on this server');
  const seal = (text) => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', need(), iv);
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  };
  const open = (sealed) => {
    const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', need(), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  };
  const checkUrl = (raw, label) => {
    let u;
    try { u = new URL(String(raw || '')); } catch { fail(400, `${label} must be a full address like https://api.example.com/v1`); }
    if (u.protocol !== 'https:' && !allowPrivate) fail(400, `${label} must start with https://`);
    return u;
  };
  const checkHost = async (u) => {
    if (allowPrivate) return;
    const ips = await dns.lookup(u.hostname, { all: true }).catch(() => fail(502, `cannot find ${u.hostname}`));
    if (ips.some((a) => privateAddress(a.address))) fail(400, `${u.hostname} is on a private network`);
  };
  const parseCfg = (raw, authType) => {
    let cfg = {};
    if (raw != null && raw !== '') {
      if (typeof raw === 'string') { try { cfg = JSON.parse(raw); } catch { fail(400, 'config must be valid JSON'); } }
      else if (typeof raw === 'object' && !Array.isArray(raw)) cfg = raw;
      else fail(400, 'config must be a JSON object');
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) fail(400, 'config must be a JSON object');
    const out = {};
    if (cfg.extra_headers) {
      if (typeof cfg.extra_headers !== 'object' || Array.isArray(cfg.extra_headers)) fail(400, 'extra_headers must be an object');
      out.extra_headers = {};
      for (const [k, v] of Object.entries(cfg.extra_headers)) {
        if (!HDR_RE.test(k)) fail(400, `bad header name: ${k}`);
        out.extra_headers[k] = String(v);
      }
    }
    if (cfg.param_headers) {
      if (typeof cfg.param_headers !== 'object' || Array.isArray(cfg.param_headers)) fail(400, 'param_headers must be an object');
      out.param_headers = {};
      for (const [k, v] of Object.entries(cfg.param_headers)) {
        if (!HDR_RE.test(String(v))) fail(400, `bad header name: ${v}`);
        out.param_headers[k] = String(v);
      }
    }
    if (cfg.email_header) {
      if (!HDR_RE.test(String(cfg.email_header))) fail(400, 'bad email_header');
      out.email_header = String(cfg.email_header);
    }
    if (cfg.allowed_paths) {
      if (!Array.isArray(cfg.allowed_paths)) fail(400, 'allowed_paths must be an array of regex strings');
      out.allowed_paths = cfg.allowed_paths.map((p) => { try { new RegExp(String(p)); } catch { fail(400, `bad path regex: ${p}`); } return String(p); });
    }
    if (cfg.extra_params) {
      if (typeof cfg.extra_params !== 'object' || Array.isArray(cfg.extra_params)) fail(400, 'extra_params must be an object');
      out.extra_params = Object.fromEntries(Object.entries(cfg.extra_params).map(([k, v]) => [k, String(v)]));
    }
    if (authType === 'oauth2_refresh_token' || authType === 'oauth2_client_credentials') {
      out.token_url = checkUrl(cfg.token_url, 'config.token_url').href;
      if (cfg.scopes) out.scopes = String(cfg.scopes);
    }
    if (authType === 'broker') {
      out.broker_url = checkUrl(cfg.broker_url, 'config.broker_url').href;
      if (cfg.path_template) out.path_template = String(cfg.path_template);
    }
    if (authType === 'google_dwd') {
      const sc = Array.isArray(cfg.scopes) ? cfg.scopes.map(String) : String(cfg.scopes || '').split(/\s+/).filter(Boolean);
      if (!sc.length) fail(400, 'config.scopes is required for google_dwd');
      out.scopes = sc;
    }
    if (cfg.credit_guard) {
      if (cfg.credit_guard !== 'apollo') fail(400, 'credit_guard must be "apollo"');
      out.credit_guard = 'apollo';
    }
    return out;
  };
  const readCfg = (c) => { try { return JSON.parse(c.config || '{}'); } catch { return {}; } };
  const tokCache = new Map();
  const clearCache = (cid) => { for (const k of tokCache.keys()) if (k === cid || k.startsWith(`${cid}\0`)) tokCache.delete(k); };
  const conn = (o, name) => one('SELECT * FROM connections WHERE org_id=:o AND name=:n', { o: o.id, n: name }) || fail(404, `${o.slug} has no connection named ${name}`);
  const levelOf = (c, u) => (role(c.org_id, u) ? one('SELECT level FROM access WHERE connection_id=:c AND user_id=:u', { c: c.id, u })?.level || c.default_level : 'none');
  const admins = (orgId) => all(`SELECT user_id FROM members WHERE org_id=:o AND role IN ('owner','admin')`, { o: orgId }).map((x) => x.user_id);
  const pub = (c, u, withPeople) => ({
    name: c.name, description: c.description, base_url: c.base_url, auth_type: c.auth_type || 'header', auth_header: c.auth_header, config: readCfg(c),
    default_level: c.default_level, my_level: levelOf(c, u),
    ...(withPeople ? { people: all(`SELECT u.id, u.handle, u.name, m.role, a.level FROM members m JOIN users u ON u.id=m.user_id
        LEFT JOIN access a ON a.connection_id=:c AND a.user_id=u.id WHERE m.org_id=:o ORDER BY u.handle`, { c: c.id, o: c.org_id })
      .map((p) => ({ ...p, level: p.level || c.default_level, set: !!p.level })) } : {}),
  });

  r('GET', '/api/orgs/([\\w-]+)/connections', false, ({ me, m }) => {
    const o = getOrg(m[1]);
    if (!role(o.id, me.id)) fail(404, 'no such organization');
    const admin = isAdmin(o.id, me.id);
    return { enabled: !!key, levels: LEVELS, auth_types: AUTH_TYPES, connections: all('SELECT * FROM connections WHERE org_id=:o ORDER BY name', { o: o.id }).map((c) => pub(c, me.id, admin)) };
  });
  // Add or change a connection. The secret is written once; leave it out to keep the current one.
  r('POST', '/api/orgs/([\\w-]+)/connections', false, ({ me, m, body }) => {
    const o = getOrg(m[1]);
    if (!isAdmin(o.id, me.id)) fail(403, 'only admins add connections');
    need();
    const name = String(body.name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) fail(400, 'name must be lowercase letters, digits and dashes');
    const base = checkUrl(body.base_url, 'base_url');
    const level = body.default_level ?? 'none';
    if (!LEVELS.includes(level)) fail(400, `default_level must be one of ${LEVELS.join(', ')}`);
    const authType = String(body.auth_type || 'header').trim();
    if (!AUTH_TYPES.includes(authType)) fail(400, `auth_type must be one of ${AUTH_TYPES.join(', ')}`);
    const header = String(body.auth_header || 'Authorization').trim();
    if (!HDR_RE.test(header)) fail(400, 'auth_header must be a header name like Authorization or X-Api-Key');
    const cfg = parseCfg(body.config, authType);
    const old = one('SELECT * FROM connections WHERE org_id=:o AND name=:n', { o: o.id, n: name });
    if (!old && !body.secret) fail(400, 'give the secret value (for example "Bearer sk_live_...")');
    const secretVal = body.secret != null ? (typeof body.secret === 'string' ? body.secret : JSON.stringify(body.secret)) : null;
    if (secretVal && ['oauth2_refresh_token', 'oauth2_client_credentials', 'google_dwd', 'query_params'].includes(authType)) {
      let parsed;
      try { parsed = JSON.parse(secretVal); } catch { fail(400, `secret for ${authType} must be JSON`); }
      if (authType === 'google_dwd' && (!parsed.client_email || !parsed.private_key)) fail(400, 'google_dwd secret needs client_email and private_key');
    }
    const v = { o: o.id, n: name, d: String(body.description || '').slice(0, 500), b: base.href.replace(/\/$/, ''), h: header, l: level,
      s: secretVal ? seal(secretVal) : old.secret, t: now(), at: authType, cfg: JSON.stringify(cfg) };
    if (old) {
      run('UPDATE connections SET description=:d, base_url=:b, auth_header=:h, default_level=:l, secret=:s, auth_type=:at, config=:cfg WHERE org_id=:o AND name=:n', v);
      clearCache(old.id);
    } else {
      run('INSERT INTO connections(id,org_id,name,description,base_url,auth_header,secret,default_level,created,auth_type,config) VALUES(:id,:o,:n,:d,:b,:h,:s,:l,:t,:at,:cfg)', { ...v, id: rid(9) });
    }
    return { connection: pub(conn(o, name), me.id, true) };
  });
  r('DELETE', '/api/orgs/([\\w-]+)/connections/([\\w-]+)', false, ({ me, m }) => {
    const o = getOrg(m[1]), c = conn(o, m[2]);
    if (!isAdmin(o.id, me.id)) fail(403, 'only admins remove connections');
    clearCache(c.id);
    run('DELETE FROM connections WHERE id=:c', { c: c.id });
    return { ok: true };
  });
  // level null puts the person back on the connection's default.
  r('PUT', '/api/orgs/([\\w-]+)/connections/([\\w-]+)/access', false, ({ me, m, body }) => {
    const o = getOrg(m[1]), c = conn(o, m[2]);
    if (!isAdmin(o.id, me.id)) fail(403, 'only admins decide who may use a connection');
    if (!role(o.id, body.user)) fail(400, 'that person is not in the organization');
    if (body.level === null) run('DELETE FROM access WHERE connection_id=:c AND user_id=:u', { c: c.id, u: body.user });
    else if (!LEVELS.includes(body.level)) fail(400, `level must be one of ${LEVELS.join(', ')}`);
    else run('INSERT OR REPLACE INTO access VALUES(:c,:u,:l)', { c: c.id, u: body.user, l: body.level });
    return { connection: pub(c, me.id, true) };
  });

  async function resolveAuth(c, cfg, callerEmail) {
    const type = c.auth_type || 'header';
    const raw = open(c.secret);
    if (type === 'header') return { headers: { [c.auth_header]: raw } };
    if (type === 'query_params') return { params: { ...(cfg.extra_params || {}), ...JSON.parse(raw) } };
    const hit = (k) => { const x = tokCache.get(k); return x && x.exp > now() + 60e3 ? x : null; };
    if (type === 'oauth2_refresh_token') {
      const cached = hit(c.id);
      if (cached) return { headers: { Authorization: `Bearer ${cached.token}` } };
      const { client_id, client_secret, refresh_token } = JSON.parse(raw);
      const tu = checkUrl(cfg.token_url, 'token_url'); await checkHost(tu);
      const res = await fetch(tu, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id, client_secret }), signal: AbortSignal.timeout(15e3) });
      if (!res.ok) fail(502, `token refresh failed (${res.status})`);
      const tok = await res.json();
      tokCache.set(c.id, { token: tok.access_token, exp: now() + (tok.expires_in || 3600) * 1000 });
      return { headers: { Authorization: `Bearer ${tok.access_token}` } };
    }
    if (type === 'oauth2_client_credentials') {
      const cached = hit(c.id);
      if (cached) return { headers: { Authorization: `Bearer ${cached.token}` } };
      const { client_id, client_secret } = JSON.parse(raw);
      const tu = checkUrl(cfg.token_url, 'token_url'); await checkHost(tu);
      const form = new URLSearchParams({ grant_type: 'client_credentials', ...(cfg.scopes ? { scope: cfg.scopes } : {}) });
      const basic = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
      const res = await fetch(tu, { method: 'POST', headers: { Accept: 'application/json', Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form, signal: AbortSignal.timeout(15e3) });
      if (!res.ok) fail(502, `client credentials token failed (${res.status})`);
      const tok = await res.json();
      tokCache.set(c.id, { token: tok.access_token, exp: now() + (tok.expires_in || 3600) * 1000 });
      return { headers: { Authorization: `Bearer ${tok.access_token}` } };
    }
    if (type === 'broker') {
      const cached = hit(c.id);
      if (cached) return { headers: { Authorization: `Bearer ${cached.token}` }, realm: cached.realm };
      const bu = checkUrl(cfg.broker_url, 'broker_url'); await checkHost(bu);
      const res = await fetch(bu, { headers: { Authorization: `Bearer ${raw}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15e3) });
      if (!res.ok) fail(502, `token broker failed (${res.status})`);
      const d = await res.json();
      const ttl = Math.min(Math.max((d.expires_in_seconds || d.expires_in || 180) - 60, 30), 300) * 1000;
      tokCache.set(c.id, { token: d.access_token, realm: d.realm_id || '', exp: now() + ttl });
      return { headers: { Authorization: `Bearer ${d.access_token}` }, realm: d.realm_id || '' };
    }
    if (type === 'google_dwd') {
      if (!callerEmail) fail(403, 'this service needs your account email');
      const ck = `${c.id}\0${callerEmail.toLowerCase()}`;
      const cached = hit(ck);
      if (cached) return { headers: { Authorization: `Bearer ${cached.token}` } };
      const sa = JSON.parse(raw);
      const tu = checkUrl(sa.token_uri || 'https://oauth2.googleapis.com/token', 'token_uri'); await checkHost(tu);
      const iat = Math.floor(Date.now() / 1000);
      const head = b64u({ alg: 'RS256', typ: 'JWT' });
      const claim = b64u({ iss: sa.client_email, sub: callerEmail, scope: (cfg.scopes || []).join(' '), aud: tu.href, iat, exp: iat + 3600 });
      const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key, 'base64url');
      const res = await fetch(tu, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }), signal: AbortSignal.timeout(15e3) });
      if (!res.ok) fail(502, `Google token failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const tok = await res.json();
      tokCache.set(ck, { token: tok.access_token, exp: now() + (tok.expires_in || 3600) * 1000 });
      return { headers: { Authorization: `Bearer ${tok.access_token}` } };
    }
    fail(500, `unknown auth_type ${type}`);
  }

  async function send(c, method, p, body, callerEmail) {
    const cfg = readCfg(c);
    const rawPath = String(p || '');
    if (cfg.allowed_paths?.length) {
      const [pathOnly] = rawPath.split('?');
      if (/[%\\#]/.test(pathOnly) || /[\x00-\x20\x7f]/.test(pathOnly) || pathOnly.split('/').some((s) => s === '.' || s === '..'))
        fail(400, 'path must be clean and unescaped');
      const norm = '/' + pathOnly.replace(/^\/+/, '');
      if (!cfg.allowed_paths.some((re) => new RegExp(re).test(norm))) fail(403, `path ${norm} is not allowed for ${c.name}`);
    }
    const auth = await resolveAuth(c, cfg, callerEmail);
    let targetPath = rawPath;
    if (cfg.path_template) {
      const [po, qs] = rawPath.split('?');
      const norm = '/' + po.replace(/^\/+/, '');
      targetPath = cfg.path_template.replace('{realm_id}', auth.realm || '').replace('{path}', norm) + (qs ? `?${qs}` : '');
    }
    const base = new URL(c.base_url + '/');
    const url = new URL(targetPath.replace(/^\/+/, ''), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) fail(400, `path must stay under ${c.base_url}`);
    await checkHost(url);
    const headers = { Accept: 'application/json, text/plain;q=0.9, */*;q=0.5', ...(cfg.extra_headers || {}) };
    if (cfg.param_headers) {
      for (const [param, hdr] of Object.entries(cfg.param_headers)) {
        const val = url.searchParams.get(param);
        if (val != null) { headers[hdr] = val; url.searchParams.delete(param); }
      }
    }
    if (cfg.email_header) {
      if (!callerEmail) fail(403, 'this service needs your account email');
      headers[cfg.email_header] = callerEmail;
    }
    Object.assign(headers, auth.headers || {});
    if (auth.params) for (const [k, v] of Object.entries(auth.params)) url.searchParams.set(k, v);
    if (body != null && !READ.includes(method)) headers['Content-Type'] = 'application/json';
    try {
      const res = await fetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(30e3),
        body: body != null && !READ.includes(method) ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
      const text = method === 'HEAD' ? '' : await res.text();
      return { http: res.status, result: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n[cut at ${MAX_RESULT} characters]` : text };
    } catch (e) { return { http: 0, result: `request failed: ${e.message}` }; }
  }
  const logOut = (x) => ({ id: x.id, connection: x.cname, by: x.handle, agent: !!x.agent, method: x.method, path: x.path, reason: x.reason, status: x.status,
    http: x.http, result: x.result, body: x.body, decided_by: x.decider, created: x.created, decided: x.decided });
  const LOG_SQL = `SELECT l.*, c.name cname, c.org_id, u.handle, u.email uemail, d.handle decider FROM access_log l JOIN connections c ON c.id=l.connection_id
    JOIN users u ON u.id=l.user_id LEFT JOIN users d ON d.id=l.decided_by`;

  // Every call is logged, whether it went through, waited for approval or was refused.
  r('POST', '/api/orgs/([\\w-]+)/connections/([\\w-]+)/call', false, async ({ me, m, body }) => {
    const o = getOrg(m[1]), c = conn(o, m[2]);
    const method = String(body.method || 'GET').toUpperCase();
    if (!METHODS.includes(method)) fail(400, `method must be one of ${METHODS.join(', ')}`);
    const level = levelOf(c, me.id), read = READ.includes(method);
    const entry = { id: rid(9), c: c.id, u: me.id, a: me.tkind !== 'web' ? 1 : 0, m: method, p: String(body.path || '').slice(0, 2000),
      b: body.body == null ? null : (typeof body.body === 'string' ? body.body : JSON.stringify(body.body)).slice(0, MAX_RESULT), r: String(body.reason || '').slice(0, 500), t: now() };
    const log = (status, http = null, result = null) => run(`INSERT INTO access_log(id,connection_id,user_id,agent,method,path,body,reason,status,http,result,created)
      VALUES(:id,:c,:u,:a,:m,:p,:b,:r,:s,:h,:res,:t)`, { ...entry, s: status, h: http, res: result });
    if (level === 'none' || (level === 'read' && !read)) {
      log('refused');
      fail(403, level === 'none' ? `you do not have access to ${o.slug}/${c.name}; ask an admin` : `you may only read from ${o.slug}/${c.name}; ask an admin for more`);
    }
    const cfg = readCfg(c);
    if (cfg.credit_guard === 'apollo') {
      const est = apolloEstimate(entry.p.split('?')[0], body.body);
      if (est > 0 && !(Number(body.confirm_credits) >= est)) {
        log('refused', 409, `needs confirmation for up to ${est} credits`);
        fail(409, `This ${c.name} call can spend up to ${est} credits. Ask the user to approve, then retry with confirm_credits: ${est}.`);
      }
    }
    if (level === 'ask' && !read) {
      log('waiting');
      emit(admins(o.id), 'access', () => ({ id: entry.id }));
      return { id: entry.id, status: 'waiting', message: `Waiting for an admin of ${o.slug} to approve ${method} ${entry.p}.` };
    }
    const out = await send(c, method, entry.p, body.body, me.email);
    log('done', out.http, out.result);
    return { id: entry.id, status: 'done', ...out };
  });
  // Admins see everything in their organization; everyone else sees their own requests.
  r('GET', '/api/orgs/([\\w-]+)/access-log', false, ({ me, m, query }) => {
    const o = getOrg(m[1]);
    if (!role(o.id, me.id)) fail(404, 'no such organization');
    const admin = isAdmin(o.id, me.id);
    return { requests: all(`${LOG_SQL} WHERE c.org_id=:o AND (:all OR l.user_id=:u) AND (:st IS NULL OR l.status=:st) ORDER BY l.created DESC LIMIT 100`,
      { o: o.id, u: me.id, all: admin ? 1 : 0, st: query.get('status') || null }).map(logOut) };
  });
  const entryOf = (id, me) => {
    const x = one(`${LOG_SQL} WHERE l.id=:id`, { id }) || fail(404, 'no such request');
    if (x.user_id !== me.id && !isAdmin(x.org_id, me.id)) fail(404, 'no such request');
    return x;
  };
  r('GET', '/api/access-requests/([\\w-]+)', false, ({ me, m }) => ({ request: logOut(entryOf(m[1], me)) }));
  // Only a person (not an agent) approves, and never their own request.
  r('POST', '/api/access-requests/([\\w-]+)/(approve|reject)', false, async ({ me, m }) => {
    const x = entryOf(m[1], me);
    if (!isAdmin(x.org_id, me.id)) fail(403, 'only admins approve requests');
    if (me.tkind !== 'web') fail(403, 'a person approves requests on the website, not an agent');
    if (x.user_id === me.id) fail(403, 'someone else has to approve your own request');
    if (x.status !== 'waiting') fail(409, `that request is already ${x.status}`);
    run(`UPDATE access_log SET status='sending', decided_by=:u, decided=:t WHERE id=:id AND status='waiting'`, { id: x.id, u: me.id, t: now() });
    let out = { http: null, result: null }, status = 'rejected';
    if (m[2] === 'approve') { out = await send(one('SELECT * FROM connections WHERE id=:c', { c: x.connection_id }), x.method, x.path, x.body, x.uemail); status = 'done'; }
    run('UPDATE access_log SET status=:s, http=:h, result=:r WHERE id=:id', { id: x.id, s: status, h: out.http, r: out.result });
    emit([x.user_id], 'access', () => ({ id: x.id }));
    return { request: logOut(entryOf(x.id, me)) };
  });

  // For the agent tools.
  const mine = (u) => all(`SELECT c.*, o.slug FROM connections c JOIN orgs o ON o.id=c.org_id JOIN members m ON m.org_id=c.org_id AND m.user_id=:u ORDER BY o.slug, c.name`, { u })
    .map((c) => ({ org: c.slug, ...pub(c, u, false) }));
  return { mine, enabled: () => !!key };
}
