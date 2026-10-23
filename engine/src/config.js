import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const HOME = homedir()
export const DATA_DIR = join(HOME, '.agentcal')

const DEFAULTS = {
  port: 4747,
  gapMinutes: 10, // silence longer than this splits a session into separate calendar blocks
  windowHours: 5, // subscription rate-limit window length used for reset inference
  scanDays: 45, // ignore transcript files older than this on first scan
  // which job phases ring the phone (plaintext push carries only {kind,name};
  // detail stays E2E-encrypted). done defaults off — asks are urgent, wins aren't.
  push: { ask: true, failed: true, done: false },
  providers: {
    claude: { roots: [join(HOME, '.claude')] },
    codex: { roots: [join(HOME, '.codex')] },
    hermes: { roots: [join(HOME, '.hermes')] },
    openclaw: { roots: [join(HOME, '.openclaw'), join(HOME, '.clawdbot')] },
    opencode: { roots: [join(HOME, '.local', 'share', 'opencode')] },
  },
}

function expand(p) {
  return p.startsWith('~') ? join(HOME, p.slice(1)) : p
}

// Roots may be strings or {path, label}. Multiple roots per provider = multiple
// accounts (e.g. CLAUDE_CONFIG_DIR-based setups). Labels distinguish them.
function normalizeRoots(roots) {
  return (roots || []).map((r, i) => {
    if (typeof r === 'string') r = { path: r }
    const path = expand(r.path)
    return { path, label: r.label || (i === 0 ? 'default' : basename(path)), explicitLabel: !!r.label }
  })
}

// Merge a patch into the user's config.json on disk (creating it if absent),
// leaving everything else in the file untouched. Used by the running engine
// to persist runtime changes like remoteHosts.
export function saveUserConfig(patch) {
  const path = process.env.AGENTCAL_CONFIG || join(DATA_DIR, 'config.json')
  let user = {}
  try {
    user = JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
  writeFileSync(path, JSON.stringify({ ...user, ...patch }, null, 2) + '\n')
}

export function loadConfig() {
  let user = {}
  try {
    user = JSON.parse(readFileSync(process.env.AGENTCAL_CONFIG || join(DATA_DIR, 'config.json'), 'utf8'))
  } catch {}
  const cfg = { ...DEFAULTS, ...user, providers: { ...DEFAULTS.providers } }
  if (user.providers) {
    for (const [name, p] of Object.entries(user.providers)) cfg.providers[name] = p
  }
  for (const p of Object.values(cfg.providers)) p.roots = normalizeRoots(p.roots)
  cfg.gapMs = cfg.gapMinutes * 60_000
  cfg.windowMs = cfg.windowHours * 3_600_000
  return cfg
}
