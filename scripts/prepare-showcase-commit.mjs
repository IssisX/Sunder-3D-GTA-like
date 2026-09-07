import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// CI has already typechecked, tested, built, and browser-checked this exact
// worktree. Create an unattached Git-data transaction; the assistant performs
// the final non-forced ref promotion after inspecting its evidence.
const expected = 'f9b681e1039c836db50341800edacfea48403654';
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const branch = process.env.GITHUB_REF_NAME;
if (!token || repo !== 'IssisX/Sunder-3D-GTA-like' ||
    process.env.GITHUB_SHA !== expected || branch !== 'ChatGPT-B-showcase') {
  throw new Error('Unexpected source revision, repository, branch, or missing authorization');
}
const api = `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repo}`;
async function request(path, method = 'GET', body) {
  const response = await fetch(api + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
const ref = await request('/git/ref/heads/ChatGPT-B-showcase');
if (ref.object.sha !== expected) throw new Error('Showcase branch changed during validation');
const parent = await request(`/git/commits/${expected}`);
const paths = [
  'src/game/body-render-core.ts',
  'src/game/body-appearance.ts',
  'src/game/soundscape.ts',
];
const sourceDoc = `# Sunder showcase integration\n\nThis revision preserves ChatGPT-B's authoritative 15-node physical human, existing locomotion, combat carrier, damage mediation, and local encounter behavior. It integrates the richer human surface, procedural environmental soundscape, and support-aware combat load transfer from the inspected competing source trees.\n\nThe appearance is read-only over solved body positions. Its scratch orientation is independent of the core renderer, its character resources are released without disposing shared geometry, and decorative weapon extents are fitted to the existing physical carrier. The audio subclass uses an independent noise buffer, removes an undefined counter in initialization, and bounds repeated event transients.\n\nThe rejected experimental boxing replacement and persistent recovery stack are not active. No recorded voice assets or external audio files were added. The source is the complete game, not a reduced demo.\n\nValidation: GitHub Actions run ${process.env.GITHUB_RUN_ID}, exact input ${expected}. TypeScript, existing targeted gameplay checks, canonical standalone build, and browser smoke must all pass before this source commit is created. The browser test checks the 15-node body, finite positions, movement, and absence of page errors. Visual quality remains subject to direct human evaluation.\n`;
const source = new Map(paths.map(path => [path, readFileSync(path, 'utf8')]));
source.set('docs/showcase-integration.md', sourceDoc);
const entries = [];
const sourceBlobs = {};
for (const [path, content] of source) {
  const blob = await request('/git/blobs', 'POST', {content, encoding:'utf-8'});
  const bytes = Buffer.from(content, 'utf8');
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (blob.sha !== hash) throw new Error(`Blob integrity mismatch: ${path}`);
  sourceBlobs[path] = blob.sha;
  entries.push({path, mode:'100644', type:'blob', sha:blob.sha});
}
const removed = [
  'scripts/repair-showcase-core.mjs',
  'scripts/repair-showcase.mjs',
  'scripts/prepare-showcase-commit.mjs',
  '.github/workflows/sunder-showcase-completion.yml',
  '.github/workflows/sunder-source-comparison.yml',
];
for (const path of removed) entries.push({path, mode:'100644', type:'blob', sha:null});
const tree = await request('/git/trees', 'POST', {base_tree:parent.tree.sha, tree:entries});
const message = 'Integrate detailed humans, soundscape and support-aware combat [build]\n\nPreserve authoritative ChatGPT-B physics and encounter behavior. Repair presentation inheritance, audio initialization, shared geometry lifetime, and visual weapon carrier bounds. Restore normal direct-build source and remove one-shot integration infrastructure.\n\nCandidate validation: typecheck, targeted gameplay checks, canonical browser build, and browser smoke.';
const commit = await request('/git/commits', 'POST', {message, tree:tree.sha, parents:[expected]});
mkdirSync('_deliverables', {recursive:true});
writeFileSync('_deliverables/showcase-commit.json', JSON.stringify({
  commit:commit.sha, tree:tree.sha, parent:expected, branch,
  sourceBlobs, removed, validationRun:process.env.GITHUB_RUN_ID,
}, null, 2));
writeFileSync('_deliverables/showcase-commit.txt', commit.sha + '\n');
writeFileSync('docs/showcase-integration.md', sourceDoc);
console.log('UNATTACHED SHOWCASE COMMIT', commit.sha, tree.sha);
