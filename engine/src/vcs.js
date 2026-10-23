import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { DATA_DIR } from './config.js'

// Job-scoped git plumbing: worktree isolation, hidden-ref checkpoints, and
// real patches. Three ideas borrowed from t3code's checkpointing/VCS layer
// (MIT), reduced to zero-dep execFile calls:
//   1. capture the working tree through an ISOLATED temp index
//      (GIT_INDEX_FILE) — includes untracked files, never touches the user's
//      staging area;
//   2. park each capture as a commit on a hidden ref
//      (refs/agentcal/jobs/<id>/base|final) — invisible to branch UIs,
//      reachable for diff/restore, and safe from gc;
//   3. diff base-tree..final-tree — exactly what the job changed, immune to
//      the user's own concurrent edits landing in the numbers when the job
//      runs in its own worktree.

export const WORKTREES_DIR = join(DATA_DIR, 'worktrees')

// commit-tree must not depend on the box having user.name/email configured
// (fresh VMs don't)
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'agentcalendar',
  GIT_AUTHOR_EMAIL: 'jobs@agentcalendar.dev',
  GIT_COMMITTER_NAME: 'agentcalendar',
  GIT_COMMITTER_EMAIL: 'jobs@agentcalendar.dev',
}

const git = (cwd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile('git', ['-C', cwd, ...args], {
    timeout: opts.timeout ?? 15_000,
    maxBuffer: 64 << 20,
    env: { ...process.env, ...GIT_IDENTITY, ...(opts.env ?? {}) },
  }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out ?? '')))
})

export async function headSha(cwd) {
  try { return (await git(cwd, ['rev-parse', 'HEAD'])).trim() } catch { return null }
}

// Working tree (tracked + untracked, .gitignore respected) as a tree object,
// via a throwaway index seeded from HEAD.
export async function captureTree(cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'acal-index-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    if (await headSha(cwd)) await git(cwd, ['read-tree', 'HEAD'], { env })
    await git(cwd, ['add', '-A'], { env, timeout: 60_000 })
    return (await git(cwd, ['write-tree'], { env })).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Snapshot the working tree onto refs/agentcal/<name>. Returns null in repos
// with no commits yet (nothing to parent onto — numstat still covers those).
export async function checkpoint(cwd, name) {
  const head = await headSha(cwd)
  if (!head) return null
  const tree = await captureTree(cwd)
  const commit = (await git(cwd, ['commit-tree', tree, '-p', head, '-m', `agentcal checkpoint ${name}`])).trim()
  const ref = `refs/agentcal/${name}`
  await git(cwd, ['update-ref', ref, commit])
  return { ref, commit, tree }
}

// {stat, patch, truncated} between two tree-ish. The stat mirrors the
// numstat shape the calendar already renders.
export async function diffBetween(cwd, a, b, { maxPatchBytes = 1 << 20 } = {}) {
  const numstat = await git(cwd, ['diff', '--numstat', a, b], { timeout: 30_000 })
  let files = 0, insertions = 0, deletions = 0
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const [i, d] = line.split('\t')
    files++
    if (i !== '-') insertions += Number(i) || 0
    if (d !== '-') deletions += Number(d) || 0
  }
  let patch = await git(cwd, ['diff', '--patch', '--no-color', a, b], { timeout: 60_000 })
  let truncated = false
  if (patch.length > maxPatchBytes) {
    patch = patch.slice(0, maxPatchBytes) + '\n… (patch truncated)\n'
    truncated = true
  }
  return { stat: { files, insertions, deletions }, patch, truncated }
}

// Dedicated worktree + branch for one job: concurrent jobs stop interleaving
// in one tree, and takeover lands somewhere safe. The branch (acal/<id>)
// survives worktree removal, so finished work stays mergeable.
export async function addJobWorktree(repo, id8) {
  mkdirSync(WORKTREES_DIR, { recursive: true })
  const path = join(WORKTREES_DIR, id8)
  const branch = `acal/${id8}`
  await git(repo, ['worktree', 'add', '-b', branch, path, 'HEAD'], { timeout: 60_000 })
  return { path, branch }
}

// Boot-time sweep: clean worktrees older than maxAgeDays are removed (git
// refuses dirty ones without --force, which is exactly the safety we want —
// a worktree holding unmerged work is never auto-deleted).
export async function pruneWorktrees(maxAgeDays = 7) {
  let entries = []
  try { entries = readdirSync(WORKTREES_DIR) } catch { return }
  for (const name of entries) {
    const wt = join(WORKTREES_DIR, name)
    try {
      if (Date.now() - statSync(wt).mtimeMs < maxAgeDays * 86_400_000) continue
      if ((await git(wt, ['status', '--porcelain'])).trim() !== '') continue
      const commonDir = (await git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
      await git(dirname(commonDir), ['worktree', 'remove', wt])
    } catch {}
  }
}
