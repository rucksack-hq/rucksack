// The Claude Code plugin, served as a read-only git repository at /plugin.git (a one-plugin marketplace).
// It adds the connector and a session-start hook that keeps the person's skills as files in ~/.claude/skills.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function pluginFiles(baseUrl, cliSource) {
  const desc = 'Your Rucksack skills as local files, kept current, plus search, chat and shared services';
  const hook = `node "\${CLAUDE_PLUGIN_ROOT}/skillnet.js" hook ${baseUrl} || echo '{"systemMessage":"Rucksack needs Node 22 or newer for local skill files (https://nodejs.org). The connector still works."}'`;
  return {
    '.claude-plugin/marketplace.json': { name: 'rucksack', description: desc, owner: { name: 'Rucksack', url: baseUrl }, plugins: [{ name: 'rucksack', source: './plugin', description: desc }] },
    'plugin/.claude-plugin/plugin.json': { name: 'rucksack', description: desc, author: { name: 'Rucksack', url: baseUrl }, homepage: baseUrl },
    // The header tells the server this machine gets files, so it leaves the skill list out of the connector.
    'plugin/.mcp.json': { mcpServers: { rucksack: { type: 'http', url: `${baseUrl}/mcp`, headers: { 'X-Rucksack-Files': '1' } } } },
    'plugin/hooks/hooks.json': { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook, timeout: 20 }] }] } },
    'plugin/skillnet.js': cliSource,
  };
}

// Rebuilt at every start; fixed commit dates keep the commit id unchanged while the content is the same, so clients see no update.
export function buildPluginRepo(gitDir, baseUrl, cliSource) {
  const repo = path.join(gitDir, '_plugin.git'), work = path.join(gitDir, '_plugin-work');
  for (const d of [repo, work]) fs.rmSync(d, { recursive: true, force: true });
  for (const [p, v] of Object.entries(pluginFiles(baseUrl, cliSource))) {
    fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
    fs.writeFileSync(path.join(work, p), typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Rucksack', GIT_AUTHOR_EMAIL: 'plugin@rucksack', GIT_COMMITTER_NAME: 'Rucksack', GIT_COMMITTER_EMAIL: 'plugin@rucksack',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', [`--git-dir=${repo}`, `--work-tree=${work}`, ...a], { env, stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', repo]);
  git('add', '-A'); git('commit', '-q', '-m', 'Rucksack plugin'); git('repack', '-a', '-d', '-q'); git('update-server-info');
  fs.rmSync(work, { recursive: true, force: true });
  return repo;
}

// Dumb HTTP: git clone reads info/refs, HEAD and the pack files as plain files.
export function servePlugin(repo, url, res) {
  const rel = path.normalize(url.pathname.slice('/plugin.git'.length) || '/');
  const file = path.join(repo, rel);
  if (!repo || !file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end('not found\n');
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
