// Git for organization skills: every organization has a repository at /git/<org>.git with one folder per skill on main.
// Editors push to main when the organization has no review rule. Anyone in the organization can push a branch; each skill folder
// it changes becomes a change request that editors approve on the website, in an agent, or both. Approving merges it into main.
// Website and agent edits are written to main as commits, so the history stays in one place.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), 'git-hook.mjs');
const ZERO = /^0+$/;

export function gitMirror({ gitDir, baseUrl, one, all, run, getOrg, role, isEditor, isAdmin, pushSkill, deleteSkill, propose, closeProposal, frontmatter, rid, now, hooks, NAME_RE }) {
  const secret = crypto.randomBytes(24).toString('base64url');
  const repoOf = (slug) => path.join(gitDir, `${slug}.git`);
  const git = (repo, args, input) => execFileSync('git', args, { cwd: repo, input, env: { PATH: process.env.PATH, HOME: gitDir, GIT_DIR: repo }, maxBuffer: 64 << 20 });
  const hasMain = (repo) => { try { git(repo, ['rev-parse', '--verify', '-q', 'refs/heads/main']); return true; } catch { return false; } };

  function ensureRepo(o) {
    const repo = repoOf(o.slug);
    const hookFile = path.join(repo, 'hooks', 'pre-receive');
    const hookText = `#!/bin/sh\nexec "${process.execPath}" "${HOOK}"\n`;
    if (!fs.existsSync(repo)) {
      fs.mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', repo], { env: { PATH: process.env.PATH, HOME: gitDir } });
      for (const [k, v] of [['receive.denyNonFastForwards', 'true'], ['receive.denyDeletes', 'true'], ['http.receivepack', 'true'], ['core.logAllRefUpdates', 'true']])
        git(repo, ['config', k, v]);
      fs.writeFileSync(hookFile, hookText, { mode: 0o755 });
      if (one('SELECT 1 x FROM skills WHERE owner_org=:o AND version>0', { o: o.id })) sync(o, { note: 'Skills already on Rucksack' });
    } else if (fs.readFileSync(hookFile, 'utf8') !== hookText) fs.writeFileSync(hookFile, hookText, { mode: 0o755 });
    return repo;
  }

  // Write the organization's current skills to main as one commit (a merge commit when an approved branch is merged).
  function sync(o, { author = null, note = '', merge = null } = {}) {
    const repo = ensureRepo(o);
    const who = author && one('SELECT handle, name FROM users WHERE id=:u', { u: author });
    const t = Math.floor(now() / 1000);
    const msg = Buffer.from(`${note || 'Update skills'}\n`);
    const parts = [`commit refs/heads/main\n`,
      who ? `author ${clean(who.name || who.handle)} <${who.handle}@users.rucksack> ${t} +0000\n` : '',
      `committer Rucksack <git@rucksack> ${t} +0000\ndata ${msg.length}\n`, msg];
    if (hasMain(repo)) parts.push('from refs/heads/main^0\n');
    if (merge) { try { git(repo, ['cat-file', '-e', `${merge}^{commit}`]); parts.push(`merge ${merge}\n`); } catch { /* branch commit gone */ } }
    parts.push('deleteall\n');
    for (const s of all('SELECT s.name, v.bundle FROM skills s JOIN versions v ON v.skill_id=s.id AND v.version=s.version WHERE s.owner_org=:o AND s.version>0 ORDER BY s.name', { o: o.id }))
      for (const [p, data] of Object.entries(JSON.parse(s.bundle))) {
        const bytes = Buffer.from(data, 'base64');
        parts.push(`M ${bytes.subarray(0, 2).toString() === '#!' ? '100755' : '100644'} inline ${s.name}/${p}\ndata ${bytes.length}\n`, bytes, '\n');
      }
    git(repo, ['fast-import', '--quiet'], Buffer.concat(parts.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x)))));
  }
  const clean = (s) => String(s).replace(/[<>\n]/g, '');
  hooks.publish.push((s, files, author, note, merge) => { if (s.owner_org) sync(getOrg(s.owner), { author, note, merge }); });
  hooks.remove.push((s, author) => { if (s.owner_org) sync(getOrg(s.owner), { author, note: `Delete ${s.name}` }); });

  // A push, checked by the pre-receive hook before git accepts it. Throwing rejects the whole push with that message.
  function onPush(body) {
    const me = one('SELECT * FROM users WHERE id=:u', { u: body.user }) || fail('unknown user');
    const o = getOrg(body.org);
    if (!role(o.id, me.id)) fail(`you are not in ${o.slug}`);
    const out = [];
    for (const u of body.updates) {
      if (!u.ref.startsWith('refs/heads/')) fail('only branches can be pushed here');
      const branch = u.ref.slice(11);
      for (const p of u.top_files || []) fail(`${p} is a file at the top level; each skill is a folder with a SKILL.md in it`);
      for (const [name, f] of Object.entries(u.skills)) {
        if (!NAME_RE.test(name)) fail(`folder ${name}: skill names are lowercase letters, digits and dashes`);
        if (f.files && !f.files['SKILL.md']) fail(`${name}/SKILL.md is missing`);
      }
      if (branch === 'main') {
        if (!isEditor(o.id, me.id)) fail(`only editors and admins of ${o.slug} change main. Push a branch instead (git push origin HEAD:my-change) and an editor approves it.`);
        if (o.review > 0) fail(`main in ${o.slug} needs ${o.review} approval${o.review > 1 ? 's' : ''} for every change. Push a branch (git push origin HEAD:my-change); it becomes a change request.`);
        const gone = Object.entries(u.skills).filter(([, f]) => !f.files).map(([n]) => n);
        if (gone.length && !isAdmin(o.id, me.id)) fail(`only admins delete skills (${gone.join(', ')})`);
        for (const [name, f] of Object.entries(u.skills)) {
          const s = one(`SELECT s.*, o.slug owner FROM skills s JOIN orgs o ON o.id=s.owner_org WHERE s.owner_org=:o AND s.name=:n`, { o: o.id, n: name });
          if (!f.files) { if (s) { deleteSkill(me, s, { fromGit: true }); out.push(`deleted ${o.slug}/${name}`); } continue; }
          const r = pushSkill(me, { org: o.slug, name, files: f.files, note: u.subject }, me.id, { fromGit: true });
          if (r.changed) out.push(`published ${o.slug}/${name} version ${r.skill.version}`);
        }
        continue;
      }
      if (ZERO.test(u.new)) { // branch deleted: its change requests close
        for (const p of all(`SELECT id FROM proposals WHERE branch=:b AND status='open' AND skill_id IN (SELECT id FROM skills WHERE owner_org=:o)`, { b: u.ref, o: o.id })) closeProposal(p.id, 'declined');
        continue;
      }
      for (const [name, f] of Object.entries(u.skills)) {
        if (!f.files) { out.push(`${name}: deleting a skill is done by an admin on the website; skipped`); continue; }
        let s = one(`SELECT s.*, o.slug owner FROM skills s JOIN orgs o ON o.id=s.owner_org WHERE s.owner_org=:o AND s.name=:n`, { o: o.id, n: name });
        if (!s) { // a new skill: a draft that nobody gets until the request is approved
          const fm = frontmatter(Buffer.from(f.files['SKILL.md'], 'base64').toString('utf8'));
          run(`INSERT INTO skills(id,owner_user,owner_org,name,description,visibility,required,updated) VALUES(:id,NULL,:o,:n,:d,'org',0,:t)`,
            { id: rid(9), o: o.id, n: name, d: String(fm.description || '').slice(0, 1024), t: now() });
          s = one(`SELECT s.*, o.slug owner FROM skills s JOIN orgs o ON o.id=s.owner_org WHERE s.owner_org=:o AND s.name=:n`, { o: o.id, n: name });
        }
        try {
          const p = propose(me, s, f.files, { note: u.subject, branch: u.ref, commit: u.new, baseFiles: f.base || {} });
          out.push(`change request for ${o.slug}/${name}: ${baseUrl}/s/${s.id}#suggestions (needs ${p.needs} approval${p.needs > 1 ? 's' : ''})`);
        } catch (e) { if (!/same as the current/.test(e.message)) throw e; out.push(`${name}: same as main, nothing to review`); }
      }
    }
    return out;
  }
  const fail = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };

  async function hookRoute(req, res, readBody) {
    let out;
    try {
      const b = JSON.parse(await readBody(req));
      const ok = typeof b.secret === 'string' && b.secret.length === secret.length && crypto.timingSafeEqual(Buffer.from(b.secret), Buffer.from(secret));
      out = ok ? { ok: true, messages: onPush(b) } : { ok: false, error: 'bad hook secret' };
    } catch (e) { out = { ok: false, error: e.status ? e.message : 'server error' }; if (!e.status) console.error('git hook', e); }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  }

  // Smart HTTP through git http-backend. Sign in with any user name and an API key (or connector token) as the password.
  function serve(req, res, url, auth) {
    const m = /^\/git\/([a-z0-9-]+)\.git(\/.*)?$/.exec(url.pathname);
    if (!m) return res.writeHead(404).end('not found\n');
    const basic = /^Basic (\S+)$/.exec(req.headers.authorization || '')?.[1];
    const pw = basic ? Buffer.from(basic, 'base64').toString().split(':').slice(1).join(':') : '';
    const me = pw ? auth({ headers: { authorization: `Bearer ${pw}` } }, true) : null;
    const deny = (code, msg) => res.writeHead(code, { 'Content-Type': 'text/plain', ...(code === 401 ? { 'WWW-Authenticate': 'Basic realm="Rucksack"' } : {}) }).end(`${msg}\n`);
    if (!me) return deny(401, `Sign in with your Rucksack handle and an API key from ${baseUrl}/devices as the password`);
    const o = one('SELECT * FROM orgs WHERE slug=:s', { s: m[1] });
    if (!o || !role(o.id, me.id)) return deny(404, 'no such organization repository');
    const pushing = url.searchParams.get('service') === 'git-receive-pack' || m[2] === '/git-receive-pack';
    if (pushing && me.scope === 'read') return deny(403, 'this key is read-only; make a write key to push');
    ensureRepo(o);
    const a = req.socket.localAddress, host = a.includes(':') ? `[${a}]` : a;
    const cgi = spawn('git', ['http-backend'], { env: {
      PATH: process.env.PATH, HOME: gitDir, GIT_PROJECT_ROOT: gitDir, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${o.slug}.git${m[2] || ''}`,
      REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: me.id, REMOTE_ADDR: '127.0.0.1',
      ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
      ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
      SKILLNET_HOOK_URL: `http://${host}:${req.socket.localPort}/internal/git-hook`, SKILLNET_HOOK_SECRET: secret, SKILLNET_ORG: o.slug } });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0), sent = false;
    cgi.stdout.on('data', (c) => {
      if (sent) return res.write(c);
      head = Buffer.concat([head, c]);
      const i = head.indexOf('\r\n\r\n'), j = head.indexOf('\n\n');
      const end = i >= 0 && (j < 0 || i < j) ? [i, 4] : j >= 0 ? [j, 2] : null;
      if (!end) return;
      const headers = {}; let status = 200;
      for (const line of head.subarray(0, end[0]).toString().split(/\r?\n/)) {
        const k = line.indexOf(':'); if (k < 0) continue;
        const name = line.slice(0, k).trim(), val = line.slice(k + 1).trim();
        if (name.toLowerCase() === 'status') status = parseInt(val, 10); else headers[name] = val;
      }
      res.writeHead(status, headers); sent = true;
      res.write(head.subarray(end[0] + end[1]));
    });
    cgi.stdout.on('end', () => { if (!sent) res.writeHead(500); res.end(); });
    cgi.stderr.on('data', (c) => console.error('git http-backend:', String(c).trim()));
    cgi.on('error', (e) => { console.error('git http-backend', e.message); if (!sent) res.writeHead(500).end(); });
  }

  return { serve, hookRoute, sync, ensureRepo };
}
