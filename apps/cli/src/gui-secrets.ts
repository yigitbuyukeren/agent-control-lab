const MASK = '[maskelendi]';

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${MASK}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [/\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|passw(?:or)?d|credential|authorization)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi, `$1$2${MASK}`],
];

/** Best-effort removal of credentials from text shown in the GUI; it never replaces not putting secrets there in the first place. */
export function maskSecrets(text: string, extra: readonly string[] = []): string {
  let out = text;
  for (const secret of extra) if (secret.length >= 8) out = out.split(secret).join(MASK);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
