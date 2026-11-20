// Change review, the git repository per organization, and shared service access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { openDb, createApp, merge3 } from '../server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rucksack-review-'));
let server, base, app, db, upstream, upBase;
const jar = {}, seen = [];

before(async () => {
  server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  db = openDb(':memory:');
  app = createApp({ db, baseUrl: base, gitDir: path.join(tmp, 'git'), secretKey: 'test-secret', allowPrivate: true });
  // A stand-in for a real service: echoes what it got, including the auth header Rucksack added.
  upstream = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b }); res.end(JSON.stringify({ ok: true, method: req.method, url: req.url })); });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upBase = `http://127.0.0.1:${upstream.address().port}/v1`;
});
after(() => { for (const s of [server, upstream]) { s.closeAllConnections(); s.close(); } fs.rmSync(tmp, { recursive: true, force: true }); });

async function as(who, method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers }, body: body && JSON.stringify(body) });
  const c = res.headers.get('set-cookie');
  if (c) jar[who] = c.split(';')[0];
  return { http: res.status, ...(await res.json().catch(() => ({}))) };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const md = (name, body) => b64(`---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
const text = (files, p = 'SKILL.md') => Buffer.from(files[p], 'base64').toString();
const bundle = async (who, id) => (await as(who, 'GET', `/api/skills/${id}/bundle`)).files;

test('merge3 keeps both sides and flags real conflicts', () => {
  assert.deepEqual(merge3({ a: '1', b: '1' }, { a: '2', b: '1' }, { a: '1', b: '3' }), { files: { a: '2', b: '3' }, conflicts: [] });
  assert.deepEqual(merge3({ a: '1' }, { a: '2' }, { a: '3' }).conflicts, ['a']);
  assert.deepEqual(merge3({ a: '1', b: '1' }, { a: '1' }, { a: '1', b: '1', c: '1' }).files, { a: '1', c: '1' }, 'deletes and additions');
});

test('reviews, git and shared services', async (t) => {
  const ids = {}, keys = {};
  for (const u of ['alice', 'bob', 'carol', 'dan']) {
    await as(u, 'POST', '/api/signup', { email: `${u}@x.com`, handle: u, password: 'password123' });
    ids[u] = (await as(u, 'GET', '/api/me')).user.id;
    keys[u] = (await as(u, 'POST', '/api/keys', { label: 'git', scope: 'write' })).key;
  }
  await as('alice', 'POST', '/api/orgs', { slug: 'acme', name: 'Acme' });
  db.prepare(`UPDATE orgs SET plan='team'`).run(); // four people is past the free plan
  const code = new URL((await as('alice', 'GET', '/api/orgs/acme')).org.invite).searchParams.get('code');
  for (const u of ['bob', 'carol', 'dan']) await as(u, 'POST', '/api/join', { code });
  await as('alice', 'POST', `/api/orgs/acme/members/${ids.bob}`, { role: 'editor' });
  await as('alice', 'POST', `/api/orgs/acme/members/${ids.carol}`, { role: 'editor' });
  const first = await as('alice', 'POST', '/api/skills/push', { org: 'acme', files: { 'SKILL.md': md('handbook', 'one\ntwo\nthree'), 'faq.md': b64('q') }, note: 'start' });
  const id = first.skill.id;

  await t.test('with no review rule, editors publish and members suggest', async () => {
    assert.equal((await as('bob', 'POST', '/api/skills/push', { org: 'acme', name: 'handbook', files: { ...(await bundle('bob', id)), 'faq.md': b64('q2') } })).changed, true);
    const p = (await as('dan', 'POST', `/api/skills/${id}/proposals`, { files: { ...(await bundle('dan', id)), 'SKILL.md': md('handbook', 'one\ntwo\nthree\nfour') }, note: 'add four' })).proposal;
    assert.equal(p.needs, 1);
    const r = await as('bob', 'POST', `/api/proposals/${p.id}/approve`);
    assert.equal(r.merged, true);
    assert.equal(r.skill.version, 3);
  });

  await t.test('only admins set the review rule', async () => {
    assert.equal((await as('bob', 'POST', '/api/orgs/acme/settings', { review: 1 })).http, 403);
    assert.equal((await as('alice', 'POST', '/api/orgs/acme/settings', { review: 1 })).review, 1);
    assert.equal((await as('dan', 'GET', '/api/orgs/acme')).org.review, 1);
  });

  let pid;
  await t.test('with review on, an editor push waits for another editor', async () => {
    const r = await as('bob', 'POST', '/api/skills/push', { org: 'acme', name: 'handbook', files: { ...(await bundle('bob', id)), 'SKILL.md': md('handbook', 'ONE\ntwo\nthree\nfour') }, note: 'caps' });
    assert.equal(r.changed, false);
    assert.equal(r.skill.version, 3, 'nothing published yet');
    pid = r.proposal.id;
    assert.equal((await as('bob', 'POST', `/api/proposals/${pid}/approve`)).http, 403, 'not your own');
    assert.equal((await as('dan', 'POST', `/api/proposals/${pid}/approve`)).http, 403, 'members cannot approve');
    const list = (await as('carol', 'GET', `/api/proposals?skill=${id}`)).proposals;
    assert.equal(list[0].can_approve, true);
    assert.deepEqual(list[0].changed, ['SKILL.md']);
    assert.match(list[0].base_md, /^one$/m);
  });

  await t.test('approving merges newer non-conflicting changes, and conflicts block', async () => {
    // Another change lands first (approved by alice): faq.md only. Bob's SKILL.md change still merges on top of it.
    const other = (await as('carol', 'POST', '/api/skills/push', { org: 'acme', name: 'handbook', files: { ...(await bundle('carol', id)), 'faq.md': b64('q3') } })).proposal;
    assert.equal((await as('alice', 'POST', `/api/proposals/${other.id}/approve`)).merged, true);
    const r = await as('carol', 'POST', `/api/proposals/${pid}/approve`);
    assert.equal(r.merged, true);
    const now = await bundle('alice', id);
    assert.match(text(now), /ONE/);
    assert.equal(text(now, 'faq.md'), 'q3', 'the newer faq change was kept');
    // Two requests from the same version touching SKILL.md: the second one conflicts after the first merges.
    const cur = await bundle('dan', id);
    const a = (await as('dan', 'POST', `/api/skills/${id}/proposals`, { files: { ...cur, 'SKILL.md': md('handbook', 'A') } })).proposal;
    const b = (await as('dan', 'POST', `/api/skills/${id}/proposals`, { files: { ...cur, 'SKILL.md': md('handbook', 'B') } })).proposal;
    assert.equal((await as('bob', 'POST', `/api/proposals/${a.id}/approve`)).merged, true);
    assert.deepEqual((await as('bob', 'GET', `/api/proposals?skill=${id}`)).proposals.find((p) => p.id === b.id).conflicts, ['SKILL.md']);
    assert.equal((await as('bob', 'POST', `/api/proposals/${b.id}/approve`)).http, 409);
    await as('dan', 'POST', `/api/proposals/${b.id}/decline`);
  });

  await t.test('a new skill under review stays a draft nobody gets', async () => {
    const r = await as('bob', 'POST', '/api/skills/push', { org: 'acme', files: { 'SKILL.md': md('onboarding', 'hi') } });
    assert.equal(r.skill.version, 0);
    const has = async () => (await as('dan', 'GET', '/api/skills')).skills.some((s) => s.name === 'onboarding');
    assert.equal(await has(), false);
    await as('carol', 'POST', `/api/proposals/${r.proposal.id}/approve`);
    assert.equal(await has(), true);
  });

  const repo = path.join(tmp, 'work');
  // Async: the server runs in this process, so a blocking git call would never get an answer.
  const env = (who = 'x') => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@x.com`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@x.com` });
  const g = async (who, ...args) => (await run('git', args, { cwd: repo, timeout: 20e3, env: env(who) })).stdout;
  const remote = (who) => `${base.replace('://', `://${who}:${keys[who]}@`)}/git/acme.git`;
  const push = async (who, ref) => { try { return { ok: true, out: (await run('git', ['push', remote(who), ref], { cwd: repo, timeout: 20e3, env: env(who) })).stderr }; } catch (e) { return { ok: false, out: String(e.stderr) }; } };

  await t.test('every published version is a commit in the organization repository', async () => {
    await run('git', ['clone', '-q', remote('dan'), repo], { timeout: 20e3, env: env() });
    const log = await g('dan', 'log', '--format=%an|%s');
    assert.match(log, /\|start/);
    assert.match(log, /dan\|add four/, 'the proposer is the author');
    assert.match(fs.readFileSync(path.join(repo, 'handbook', 'SKILL.md'), 'utf8'), /^A$/m);
    assert.ok(fs.existsSync(path.join(repo, 'onboarding', 'SKILL.md')));
    assert.equal((await fetch(`${base}/git/acme.git/info/refs?service=git-upload-pack`)).status, 401, 'signed out');
  });

  await t.test('pushing a branch opens a change request; approving merges it into main', async () => {
    fs.appendFileSync(path.join(repo, 'handbook', 'SKILL.md'), 'from git\n');
    await g('dan', 'commit', '-qam', 'Add a line from git');
    const r = await push('dan', 'HEAD:refs/heads/dan-line');
    assert.ok(r.ok, r.out);
    const p = (await as('bob', 'GET', `/api/proposals?skill=${id}`)).proposals.find((x) => x.branch === 'dan-line');
    assert.ok(p, 'change request exists');
    assert.equal(p.note, 'Add a line from git');
    // A second push to the same branch replaces it.
    fs.appendFileSync(path.join(repo, 'handbook', 'SKILL.md'), 'and another\n');
    await g('dan', 'commit', '-qam', 'Two lines');
    assert.ok((await push('dan', 'HEAD:refs/heads/dan-line')).ok);
    const again = (await as('bob', 'GET', `/api/proposals?skill=${id}`)).proposals.filter((x) => x.branch === 'dan-line');
    assert.equal(again.length, 1);
    assert.equal(again[0].id, p.id);
    assert.equal((await as('bob', 'POST', `/api/proposals/${p.id}/approve`)).merged, true);
    assert.match(text(await bundle('alice', id)), /from git\nand another/);
    await g('dan', 'pull', '-q', '--no-rebase', remote('dan'), 'main');
    assert.match(await g('dan', 'log', '-1', '--format=%P'), / /, 'main got a merge commit');
  });

  await t.test('main is protected', async () => {
    fs.writeFileSync(path.join(repo, 'handbook', 'faq.md'), 'direct\n');
    await g('dan', 'commit', '-qam', 'Straight to main');
    let r = await push('dan', 'HEAD:refs/heads/main');
    assert.equal(r.ok, false);
    assert.match(r.out, /only editors and admins/);
    r = await push('bob', 'HEAD:refs/heads/main');
    assert.equal(r.ok, false, 'review rule on');
    assert.match(r.out, /needs 1 approval/);
    await as('alice', 'POST', '/api/orgs/acme/settings', { review: 0 });
    r = await push('bob', 'HEAD:refs/heads/main');
    assert.ok(r.ok, r.out);
    assert.match(r.out, /published acme\/handbook/);
    assert.equal(text(await bundle('alice', id), 'faq.md'), 'direct\n');
    fs.writeFileSync(path.join(repo, 'stray.txt'), 'x');
    await g('bob', 'add', '.'); await g('bob', 'commit', '-qm', 'stray');
    r = await push('bob', 'HEAD:refs/heads/main');
    assert.equal(r.ok, false);
    assert.match(r.out, /each skill is a folder/);
  });

  await t.test('shared services: keys stay on the server and access follows each person', async () => {
    assert.equal((await as('bob', 'POST', '/api/orgs/acme/connections', { name: 'crm', base_url: upBase, secret: 'Bearer s3cret' })).http, 403);
    const c = await as('alice', 'POST', '/api/orgs/acme/connections', { name: 'crm', base_url: upBase, secret: 'Bearer s3cret', description: 'Our CRM', default_level: 'read' });
    assert.equal(c.connection.name, 'crm');
    assert.ok(!JSON.stringify(c).includes('s3cret'));
    assert.ok(!JSON.stringify(await as('alice', 'GET', '/api/orgs/acme/connections')).includes('s3cret'));
    const call = (who, body, headers) => as(who, 'POST', '/api/orgs/acme/connections/crm/call', body, headers);
    // Read access: GET goes through with the key added; POST is refused.
    let r = await call('dan', { path: '/contacts?q=x' });
    assert.equal(r.status, 'done');
    assert.equal(seen.at(-1).auth, 'Bearer s3cret');
    assert.equal(seen.at(-1).url, '/v1/contacts?q=x');
    assert.equal((await call('dan', { method: 'POST', path: 'contacts', body: { a: 1 } })).http, 403);
    assert.equal((await call('dan', { path: '../admin' })).http, 400, 'cannot leave the base path');
    // Ask: the change waits; an agent cannot approve; another admin (a person) does.
    await as('alice', 'PUT', '/api/orgs/acme/connections/crm/access', { user: ids.dan, level: 'ask' });
    const agent = { Authorization: `Bearer ${keys.dan}`, Cookie: '' };
    r = await call('dan', { method: 'POST', path: 'contacts', body: { name: 'Pat' }, reason: 'new lead' }, agent);
    assert.equal(r.status, 'waiting');
    const n = seen.length;
    assert.equal((await as('alice', 'POST', `/api/access-requests/${r.id}/approve`, null, { Authorization: `Bearer ${keys.alice}`, Cookie: '' })).http, 403, 'agents do not approve');
    assert.equal((await as('dan', 'POST', `/api/access-requests/${r.id}/approve`)).http, 403);
    const log = (await as('alice', 'GET', '/api/orgs/acme/access-log?status=waiting')).requests;
    assert.equal(log[0].agent, true);
    assert.equal(log[0].reason, 'new lead');
    const done = (await as('alice', 'POST', `/api/access-requests/${r.id}/approve`)).request;
    assert.equal(done.status, 'done');
    assert.equal(seen.length, n + 1);
    assert.equal(seen.at(-1).body, '{"name":"Pat"}');
    assert.equal((await as('dan', 'GET', `/api/access-requests/${r.id}`)).request.http, 200);
    // None, and people outside the organization.
    await as('alice', 'PUT', '/api/orgs/acme/connections/crm/access', { user: ids.dan, level: 'none' });
    assert.equal((await call('dan', { path: 'x' })).http, 403);
    await as('alice', 'PUT', '/api/orgs/acme/connections/crm/access', { user: ids.bob, level: 'write' });
    assert.equal((await call('bob', { method: 'DELETE', path: 'contacts/1' })).status, 'done');
    assert.equal((await as('dan', 'GET', '/api/orgs/acme/access-log')).requests.every((x) => x.by === 'dan'), true, 'members see only their own calls');
  });

  await t.test('shared services: oauth2, broker, google_dwd, query_params, path allowlist, credit guard', async () => {
    const crypto = await import('node:crypto');
    const seen2 = [];
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const mock = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString();
      seen2.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/oauth/token') {
        if (body.includes('grant_type=refresh_token')) return res.end(JSON.stringify({ access_token: 'ref-tok', expires_in: 3600 }));
        if (body.includes('grant_type=client_credentials')) return res.end(JSON.stringify({ access_token: 'cc-tok', expires_in: 3600 }));
        if (body.includes('jwt-bearer')) {
          const assertion = new URLSearchParams(body).get('assertion');
          const [h, p, s] = assertion.split('.');
          const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, s, 'base64url');
          const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
          if (!ok) { res.statusCode = 401; return res.end('bad sig'); }
          return res.end(JSON.stringify({ access_token: `g-${claims.sub}`, expires_in: 3600 }));
        }
      }
      if (req.url === '/broker') return res.end(JSON.stringify({ access_token: 'brk-tok', realm_id: 'R123', expires_in_seconds: 600 }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, url: req.url, auth: req.headers.authorization, hdr: req.headers }));
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const mBase = `http://127.0.0.1:${mock.address().port}`;
    try {
      // oauth2_refresh_token + extra_headers
      await as('alice', 'POST', '/api/orgs/acme/connections', {
        name: 'dbx', base_url: `${mBase}/api`, auth_type: 'oauth2_refresh_token',
        secret: JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rtok' }),
        config: { token_url: `${mBase}/oauth/token`, extra_headers: { 'X-Root': 'team' } }, default_level: 'write',
      });
      let r = await as('alice', 'POST', '/api/orgs/acme/connections/dbx/call', { method: 'POST', path: '/files/list', body: {} });
      assert.equal(r.http, 200);
      assert.equal(seen2.at(-1).headers.authorization, 'Bearer ref-tok');
      assert.equal(seen2.at(-1).headers['x-root'], 'team');

      // oauth2_client_credentials
      await as('alice', 'POST', '/api/orgs/acme/connections', {
        name: 'ramp', base_url: `${mBase}/api`, auth_type: 'oauth2_client_credentials',
        secret: JSON.stringify({ client_id: 'rcid', client_secret: 'rcsec' }),
        config: { token_url: `${mBase}/oauth/token`, scopes: 'transactions:read' }, default_level: 'read',
      });
      r = await as('alice', 'POST', '/api/orgs/acme/connections/ramp/call', { path: '/transactions' });
      assert.equal(seen2.at(-1).headers.authorization, 'Bearer cc-tok');

      // broker + path_template
      await as('alice', 'POST', '/api/orgs/acme/connections', {
        name: 'qbo', base_url: mBase, auth_type: 'broker', secret: 'brk-key',
        config: { broker_url: `${mBase}/broker`, path_template: '/v3/company/{realm_id}{path}' }, default_level: 'read',
      });
      r = await as('alice', 'POST', '/api/orgs/acme/connections/qbo/call', { path: '/query?q=1' });
      assert.equal(seen2.at(-1).url, '/v3/company/R123/query?q=1');
      assert.equal(seen2.at(-1).headers.authorization, 'Bearer brk-tok');

      // google_dwd: impersonates authenticated caller's email (alice@x)
      await as('alice', 'POST', '/api/orgs/acme/connections', {
        name: 'gmail', base_url: `${mBase}/gmail`, auth_type: 'google_dwd',
        secret: JSON.stringify({ client_email: 'sa@proj.iam.gserviceaccount.com', private_key: privPem, token_uri: `${mBase}/oauth/token` }),
        config: { scopes: ['https://mail.google.com/'] }, default_level: 'read',
      });
      r = await as('alice', 'POST', '/api/orgs/acme/connections/gmail/call', { path: '/messages' });
      assert.equal(seen2.at(-1).headers.authorization, 'Bearer g-alice@x.com');

      // query_params + secret precedence
      await as('alice', 'POST', '/api/orgs/acme/connections', {
        name: 'nc', base_url: `${mBase}/nc`, auth_type: 'query_params',
        secret: JSON.stringify({ ApiKey: 'real-key', ApiUser: 'wbg' }),
        config: { extra_params: { ClientIp: '1.2.3.4' } }, default_level: 'read',
      });
      r = await as('alice', 'POST', '/api/orgs/acme/connections/nc/call', { path: '/xml?Command=test&ApiKey=spoof' });
      assert.match(seen2.at(-1).url, /ApiKey=real-key/);
      assert.match(seen2.at(-1).url, /ClientIp=1\.2\.3\.4/);

      // allowed_paths + param_headers + email_header
      await as('alice', 'POST', '/api/orgs/acme/connections', {
        name: 'scoped', base_url: mBase, auth_header: 'X-Key', secret: 'k1',
        config: { allowed_paths: ['^/repos/wbg/[^/]+(/.*)?$'], param_headers: { prov: 'x-provider' }, email_header: 'X-Caller-Email' }, default_level: 'read',
      });
      assert.equal((await as('alice', 'POST', '/api/orgs/acme/connections/scoped/call', { path: '/repos/other/x' })).http, 403);
      r = await as('alice', 'POST', '/api/orgs/acme/connections/scoped/call', { path: '/repos/wbg/app/issues?prov=GOOGLE' });
      assert.equal(r.http, 200);
      assert.equal(seen2.at(-1).headers['x-provider'], 'GOOGLE');
      assert.equal(seen2.at(-1).headers['x-caller-email'], 'alice@x.com');
      assert.ok(!seen2.at(-1).url.includes('prov='));

      // credit_guard (apollo)
      await as('alice', 'POST', '/api/orgs/acme/connections', {
        name: 'apollo', base_url: `${mBase}/v1`, auth_header: 'X-Api-Key', secret: 'ak',
        config: { credit_guard: 'apollo' }, default_level: 'write',
      });
      assert.equal((await as('alice', 'POST', '/api/orgs/acme/connections/apollo/call', { method: 'POST', path: '/people/match', body: { email: 'a@b.com' } })).http, 409);
      r = await as('alice', 'POST', '/api/orgs/acme/connections/apollo/call', { method: 'POST', path: '/people/match', body: { email: 'a@b.com' }, confirm_credits: 1 });
      assert.equal(r.http, 200);
    } finally {
      mock.close();
    }
  });

  await t.test('agents get the same through MCP tools', async () => {
    const mcp = async (name, args) => (await as('carol', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      { Authorization: `Bearer ${keys.carol}`, Cookie: '' })).result.content[0].text;
    assert.match(await mcp('list_services', {}), /acme\/crm: Our CRM .* you: read/);
    assert.match(await mcp('call_service', { service: 'acme/crm', path: 'contacts' }), /HTTP 200/);
    await as('dan', 'POST', `/api/skills/${id}/proposals`, { files: { ...(await bundle('dan', id)), 'faq.md': b64('agent reviewed') }, note: 'faq' });
    const listed = await mcp('list_changes', { skill: 'acme/handbook' });
    assert.match(listed, /by @dan: faq/);
    const pidAgent = /^(\S+)/.exec(listed)[1];
    assert.match(await mcp('review_change', { id: pidAgent, decision: 'approve' }), /merged/);
  });
});
