import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Model catalogs for the create-job dialog.
// claude: curated — the CLI has no list command; aliases are the intended UX
// and stay valid across model generations (same approach as GearShift).
// codex: read live from ~/.codex/models_cache.json, curated fallback.
// claude's --effort accepts the same ladder for every model (session-level)
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CLAUDE_MODELS = [
  { id: '', label: 'Default' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'sonnet[1m]', label: 'Sonnet 1M' },
  { id: 'opus', label: 'Opus' },
  { id: 'opusplan', label: 'Opus Plan' },
  { id: 'fable', label: 'Fable' },
].map((m) => ({ ...m, efforts: CLAUDE_EFFORTS }))

const CODEX_FALLBACK = [
  { id: '', label: 'Default' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
]

// Public list prices per 1M tokens for codex model families. The app-server
// reports tokens but never dollars, so codex runs would otherwise book $0
// forever and a codex role could never hit its weekly budget cap. Longest
// match wins; anything unknown falls back to mainline pricing. Estimates are
// marked costEstimated in the run audit so nobody mistakes them for billing.
const CODEX_PRICES = [
  { match: 'nano', in: 0.05, out: 0.4 },
  { match: 'mini', in: 0.25, out: 2 },
  { match: 'gpt-5.6', in: 5, out: 30 },
  { match: 'gpt-5.5', in: 5, out: 30 },
  { match: 'gpt-5.2', in: 1.75, out: 14 },
  { match: 'gpt-5.4', in: 1.75, out: 14 },
  { match: 'gpt-5.1', in: 1.25, out: 10 },
]
const CODEX_PRICE_DEFAULT = { in: 1.25, out: 10 }

export function estimateCodexCostUsd(model, tokens) {
  const input = Number(tokens?.in) || 0
  const output = Number(tokens?.out) || 0
  if (!input && !output) return null
  const id = String(model ?? '').toLowerCase()
  const price = CODEX_PRICES.find((p) => id.includes(p.match)) ?? CODEX_PRICE_DEFAULT
  return Math.round((input * price.in + output * price.out) / 1e6 * 10000) / 10000
}

export function agentModels(cfg) {
  let codex = CODEX_FALLBACK
  for (const root of cfg.providers.codex?.roots ?? []) {
    try {
      const cache = JSON.parse(readFileSync(join(root.path, 'models_cache.json'), 'utf8'))
      const models = (cache.models ?? [])
        .filter((m) => m.slug && m.visibility !== 'hide')
        .map((m) => ({
          id: m.slug,
          label: m.display_name || m.slug,
          // codex advertises reasoning levels per model in its own catalog
          efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean),
          defaultEffort: m.default_reasoning_level ?? null,
        }))
      if (models.length) {
        const allEfforts = [...new Set(models.flatMap((m) => m.efforts))]
        codex = [{ id: '', label: 'Default', efforts: allEfforts }, ...models]
        break
      }
    } catch {}
  }
  return { claude: CLAUDE_MODELS, codex }
}
