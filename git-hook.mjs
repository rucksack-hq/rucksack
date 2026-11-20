// pre-receive hook for Rucksack organization repositories. Reads what is being pushed (still in git's quarantine, so only this
// process can see it), sends the changed skill folders to the server, and accepts or rejects the push with the server's answer.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const git = (...args) => execFileSync('git', args, { maxBuffer: 64 << 20 });
const text = (...args) => git(...args).toString().trim();
const ZERO = /^0+$/;
const tops = (from, to) => [...new Set((from ? text('diff', '--name-only', '--no-renames', from, to) : text('ls-tree', '--name-only', to))
  .split('\n').filter(Boolean).map((p) => p.split('/')[0]))];
const folder = (commit, name) => {
  if (!commit) return null;
  const files = {};
  for (const line of git('ls-tree', '-r', '-z', commit, '--', `${name}/`).toString().split('\0').filter(Boolean)) {
    const [meta, p] = line.split('\t');
    const [, type, sha] = meta.split(' ');
    if (type === 'blob') files[p.slice(name.length + 1)] = git('cat-file', 'blob', sha).toString('base64');
  }
  return Object.keys(files).length ? files : null;
};
const kind = (commit, name) => { try { return commit ? text('cat-file', '-t', `${commit}:${name}`) : null; } catch { return null; } };

const updates = [];
for (const line of fs.readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
  const [old, neu, ref] = line.split(' ');
  const u = { ref, old, new: neu, skills: {}, top_files: [], subject: '' };
  updates.push(u);
  if (ZERO.test(neu)) continue;
  u.subject = text('log', '-1', '--format=%s', neu);
  const main = ref === 'refs/heads/main';
  let base = null;
  if (main) base = ZERO.test(old) ? null : old;
  else { try { base = text('merge-base', 'refs/heads/main', neu); } catch { base = null; } }
  for (const name of tops(base, neu)) {
    const now = kind(neu, name);
    if (now && now !== 'tree') { u.top_files.push(name); continue; }
    if (!now && kind(base, name) !== 'tree') continue; // a removed top-level file
    u.skills[name] = { files: folder(neu, name), base: main ? undefined : folder(base, name) };
  }
}
const res = await fetch(process.env.SKILLNET_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ secret: process.env.SKILLNET_HOOK_SECRET, user: process.env.REMOTE_USER, org: process.env.SKILLNET_ORG, updates }) })
  .then((r) => r.json()).catch((e) => ({ ok: false, error: `Rucksack did not answer (${e.message})` }));
for (const m of res.messages || []) console.error(`Rucksack: ${m}`);
if (!res.ok) { console.error(`Rucksack: push refused: ${res.error}`); process.exit(1); }
