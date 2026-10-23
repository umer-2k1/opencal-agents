import { readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

// Best-effort account identity for a provider root, read from local auth
// files. Never fetched from anywhere. Returns an email or null.
export function detectAccount(provider, root) {
  try {
    if (provider === 'claude') {
      // ~/.claude -> ~/.claude.json ; CLAUDE_CONFIG_DIR setups keep .claude.json inside the dir
      for (const p of [root + '.json', join(root, '.claude.json'), join(dirname(root), '.claude.json')]) {
        try {
          const email = JSON.parse(readFileSync(p, 'utf8'))?.oauthAccount?.emailAddress
          if (email) return email
        } catch {}
      }
    }
    if (provider === 'codex') {
      const auth = JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8'))
      const idToken = auth?.tokens?.id_token
      if (idToken) {
        const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString())
        if (payload.email) return payload.email
      }
    }
  } catch {}
  return null
}

export function labelFor(provider, root) {
  return detectAccount(provider, root.path) ?? root.label ?? basename(root.path)
}
