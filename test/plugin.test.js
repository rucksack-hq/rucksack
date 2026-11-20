// The Claude Code plugin: served as a git marketplace, its session-start hook signs the machine in and syncs files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb, createApp } from '../server.js';

const run = promisify(execFile);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rucksack-plugin-'));
let server, base, cookie;
before(async () => {
  server = http.createServer((q, s) => app.handle(q, s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  app = createApp({ db: openDb(':memory:'), baseUrl: base, gitDir: path.join(tmp, 'git') });
});
let app;
after(() => { server.closeAllConnections(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const api = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body && JSON.stringify(body) });
  cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
  return res.json();
};

test('plugin marketplace, hook sign-in and sync, connector without the skill list', async () => {
  await api('POST', '/api/signup', { email: 'p@x.com', handle: 'pat', password: 'password123' });
  await api('POST', '/api/skills/push', { files: { 'SKILL.md': Buffer.from('---\nname: notes\ndescription: d\n---\nhi').toString('base64') } });

  const dest = path.join(tmp, 'clone');
  await run('git', ['clone', '-q', `${base}/plugin.git`, dest]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, '.claude-plugin/marketplace.json'))).plugins[0].source, './plugin');
  const mcp = JSON.parse(fs.readFileSync(path.join(dest, 'plugin/.mcp.json'))).mcpServers.rucksack;
  assert.equal(mcp.url, `${base}/mcp`);
  assert.match(JSON.parse(fs.readFileSync(path.join(dest, 'plugin/hooks/hooks.json'))).hooks.SessionStart[0].hooks[0].command, /skillnet\.js" hook http/);

  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.mkdirSync(path.join(home, '.codex'));
  const env = { ...process.env, HOME: home, SKILLNET_HOME: '', SKILLNET_HOOK_NOWAIT: '1', SKILLNET_NO_SERVICE: '1' };
  delete env.SKILLNET_HOME; delete env.SKILLNET_KEY; delete env.SKILLNET_URL;
  const cliPath = path.join(dest, 'plugin/skillnet.js');
  const first = JSON.parse((await run(process.execPath, [cliPath, 'hook', base], { env })).stdout);
  const code = /approve code (\S+)\./.exec(first.systemMessage)[1];
  assert.equal(first.hookSpecificOutput.hookEventName, 'SessionStart');
  const again = JSON.parse((await run(process.execPath, [cliPath, 'hook', base], { env })).stdout);
  assert.match(again.systemMessage, new RegExp(code), 'one pending sign-in, not a new one per session');

  assert.equal((await api('POST', '/api/device/approve', { user_code: code })).ok, true);
  await run(process.execPath, [cliPath, 'hook-wait'], { env });
  assert.match(fs.readFileSync(path.join(home, '.claude/skills/notes/SKILL.md'), 'utf8'), /hi/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.config/skillnet/config.json'))).targets, [path.join(home, '.claude/skills')], 'only Claude Code\'s folder');
  assert.equal((await run(process.execPath, [cliPath, 'hook', base], { env })).stdout, '', 'signed in: syncs quietly');

  const token = JSON.parse(fs.readFileSync(path.join(home, '.config/skillnet/config.json'))).token;
  const call = (method, headers) => api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method }, { Authorization: `Bearer ${token}`, Cookie: '', ...headers });
  assert.match((await call('initialize', mcp.headers)).result.instructions, /installed on this machine/);
  assert.equal((await call('prompts/list', mcp.headers)).result.prompts.length, 0);
  assert.match((await call('initialize', {})).result.instructions, /pat\/notes/, 'other apps still get the list');
});
