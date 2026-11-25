/** Shared WinAnsi text sanitization and line-wrapping helpers for `pdf-lib` document renderers. */

export interface MeasurableFont {
  widthOfTextAtSize: (text: string, size: number) => number;
}

/** Normalizes Unicode punctuation to WinAnsi-safe ASCII for `pdf-lib` standard fonts. */
export function sanitizePdfText(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/\u2192/g, '->')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E\n]/g, ' ');
}

/** Word-wraps WinAnsi-sanitized text (splitting oversized tokens safely) to fit `maxWidth`. */
export function wrapTextLines(
  text: string,
  maxWidth: number,
  font: MeasurableFont,
  fontSize: number
): string[] {
  const clean = sanitizePdfText(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // Break ultra-long unbroken tokens safely (URLs, hashes, identifiers)
      if (font.widthOfTextAtSize(word, fontSize) > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, fontSize) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Wraps explicit-newline `<pre>` text while preserving leading indentation per line. */
export function wrapPreLines(
  text: string,
  maxWidth: number,
  font: MeasurableFont,
  fontSize: number
): string[] {
  const rawLines = sanitizePdfText(text).split('\n');
  const wrapped: string[] = [];
  for (const rawLine of rawLines) {
    const expanded = rawLine.replace(/\t/g, '  ').replace(/\s+$/g, '');
    if (!expanded) {
      wrapped.push(' ');
      continue;
    }
    if (font.widthOfTextAtSize(expanded, fontSize) <= maxWidth) {
      wrapped.push(expanded);
      continue;
    }
    let chunk = '';
    for (const ch of expanded) {
      if (font.widthOfTextAtSize(chunk + ch, fontSize) > maxWidth && chunk) {
        wrapped.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    if (chunk) wrapped.push(chunk);
  }
  return wrapped;
}
