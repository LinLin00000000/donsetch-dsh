/**
 * Tool-name and presentation helpers shared by the registration code.
 * No deps.
 */

/** DeepSeek Harness function-name contract, per the MCP docs. */
const NAME_RE = /^[A-Za-z0-9_-]+$/

/**
 * MCP protocol tool names should already satisfy [A-Za-z0-9_-]{1,64},
 * but hostile or buggy servers are a reality: sanitize defensively and
 * reject names that cannot be expressed in the harness contract.
 */
export function sanitizeRawName(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s.length === 0 || s.length > 64) return null
  if (!NAME_RE.test(s)) return null
  return s
}

/** Final public (model-facing) tool name, or null when unsupported. */
export function publicToolName(prefix: string, raw: string): string | null {
  const clean = sanitizeRawName(raw)
  if (clean === null) return null
  const full = `${prefix}_${clean}`
  if (full.length > 64) return null
  return full
}

/** Validate the user-configurable prefix: short, contract-shaped, safe. */
export function isValidPrefix(prefix: unknown): prefix is string {
  return typeof prefix === 'string' && prefix.length >= 1 && prefix.length <= 16 && NAME_RE.test(prefix)
}

/** Plain truncation, no ANSI, no ellipsis when it fits. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 3) return text.slice(0, max)
  return text.slice(0, max - 3) + '...'
}

/** Host only: compact call label, e.g. "en.wikipedia.org" or '"query"'. */
export function callFocus(args: unknown): string {
  if (args === null || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  if (typeof a.url === 'string' && a.url) {
    try {
      const u = new URL(a.url)
      const p = u.pathname === '/' ? '' : truncate(u.pathname, 30)
      return u.hostname + p
    } catch {
      return truncate(a.url, 64)
    }
  }
  if (typeof a.query === 'string' && a.query) return truncate(`"${a.query}"`, 64)
  if (typeof a.urls === 'object' && Array.isArray(a.urls) && a.urls.length > 0) {
    return `${a.urls.length} urls`
  }
  return ''
}

/** Call-card title: "toolName · focus" or the bare tool name. */
export function callTitle(toolName: string, args: unknown): string {
  const focus = callFocus(args)
  return focus ? `${toolName} \u00B7 ${focus}` : toolName
}

/** First meaningful line of a text blob, for result titles. */
export function firstLine(text: string, max: number): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^#+\s*/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/^\[meta\].*$/i, '')
      .trim()
    if (line) return truncate(line, max)
  }
  return ''
}