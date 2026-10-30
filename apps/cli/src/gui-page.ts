import { GUI_CSS } from './gui-style.ts';
import { GUI_JS } from './gui-script.ts';

const ICONS: Readonly<Record<string, string>> = {
  layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  flow: '<path d="M5 5h5v5H5z"/><path d="M14 14h5v5h-5z"/><path d="M7.5 10v2.5a2.5 2.5 0 0 0 2.5 2.5h4"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4-5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  alert: '<path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4M12 17.5v.01"/>',
  chev: '<path class="ch" d="m9 6 6 6-6 6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-4L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2M20 20v-5h-5"/>',
  spark: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/>',
  play: '<path d="M7 5v14l12-7L7 5Z"/>',
  doc: '<path d="M7 3h7l5 5v13H7V3Z"/><path d="M14 3v5h5"/>',
  term: '<path d="m5 8 4 4-4 4M12 17h7"/>',
  book: '<path d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4Z"/>',
  lock: '<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};

const sprite = Object.entries(ICONS)
  .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
  .join('');

/** The single local page of `gui`: no external resources, no browser storage, text is only ever inserted as text. */
export function guiPage(token: string, nonce: string): string {
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="acl-token" content="${token}">
<title>Agent Control Lab</title>
<style nonce="${nonce}">${GUI_CSS}
.sp{height:14px}.tw{overflow-x:auto}.pill .skel{display:inline-block;width:46px;height:8px}
.node.claude .dot{background:var(--claude)}.node.codex .dot{background:var(--codex)}.pc h2+*{margin-top:4px}</style></head>
<body><svg class="sprite" aria-hidden="true">${sprite}</svg>
<div id="app" class="app"></div>
<noscript>Bu arayüz için JavaScript gerekir.</noscript>
<script nonce="${nonce}">${GUI_JS}</script></body></html>
`;
}
