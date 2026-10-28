/**
 * dsh-notify-toast — pure text helpers for the Host half.
 *
 * These helpers turn model/tool output into the short, single-line bodies a
 * Windows toast can show. They are deliberately side-effect free and exported
 * for `node --test` (see test/text.test.mjs).
 *
 * Character accounting follows docs/INTERFACE.md: lengths are Unicode
 * code points (`Array.from(text).length`), never UTF-16 code units.
 */

/** Common named/numeric HTML entities produced by models that escape markup. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Decode the small HTML entity subset that shows up in assistant text. */
function decodeEntities(text) {
  return text
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X'
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
        if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code)
          } catch {
            return match
          }
        }
        return match
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match
    })
}

/**
 * Remove Markdown/markup decoration and collapse whitespace into one line.
 *
 * - fenced code blocks are removed (both ``` and ~~~, closed or unterminated);
 * - inline code keeps its content but loses the backticks;
 * - headings, block quotes, list bullets, tables and horizontal rules lose
 *   their markers; links keep the label, images are dropped;
 * - emphasis/strikethrough markers are removed; raw HTML tags are dropped and
 *   common entities decoded;
 * - the result has every whitespace run collapsed to one space (no newlines).
 *
 * @param {unknown} text raw text.
 * @returns {string} cleaned, single-line text ('', never null/undefined, for
 *   non-string or empty input).
 */
export function cleanMarkdownText(text) {
  if (typeof text !== 'string' || text.length === 0) return ''

  let out = text.replace(/\r\n?/g, '\n')

  // Fenced code blocks first: their content must never become notification text.
  out = out.replace(/```[^\n]*\n[\s\S]*?```/g, ' ')
  out = out.replace(/~~~[^\n]*\n[\s\S]*?~~~/g, ' ')
  // Unterminated fence: drop everything that follows it.
  out = out.replace(/```[\s\S]*$/g, ' ')
  out = out.replace(/~~~[\s\S]*$/g, ' ')

  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  // Images are noise for a toast; links keep their label. One level of
  // parentheses is allowed inside the URL target (e.g. Wikipedia links).
  out = out.replace(/!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, ' ')
  out = out.replace(/\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
  // Inline code: keep the payload, drop the backticks.
  out = out.replace(/`{1,2}([^`\n]+)`{1,2}/g, '$1')
  out = out.replace(/`/g, '')

  // Line-leading Markdown markers.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  out = out.replace(/[ \t]+#{1,6}[ \t]*$/gm, '')
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  out = out.replace(/^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, '')
  out = out.replace(/^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '')

  // Tables: separator rows disappear, remaining cell pipes become spaces.
  out = out.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, ' ')
  out = out.replace(/\|/g, ' ')

  // Markup tags (kept after link handling so `<https://...>` link wrappers die too).
  out = out.replace(/<[^>]+>/g, ' ')

  // Emphasis markers: paired forms first, then stray single markers that are
  // adjacent to whitespace so identifiers such as `file_name` survive intact.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  out = out.replace(/__([^_\n]+)__/g, '$1')
  out = out.replace(/~~([^~\n]+)~~/g, '$1')
  out = out.replace(/\*\*+/g, '')
  out = out.replace(/~~/g, '')
  out = out.replace(/(^|[\s(])\*(?=\S)/g, '$1')
  out = out.replace(/(\S)\*(?=[\s).,!?:;]|$)/g, '$1')
  out = out.replace(/(^|[\s(])_(?=\S)/g, '$1')
  out = out.replace(/(\S)_(?=[\s).,!?:;]|$)/g, '$1')

  out = decodeEntities(out)
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Return the first non-empty paragraph of a Markdown-ish text, cleaned.
 *
 * Paragraph boundaries are the blank lines of the *raw* text, so fenced code
 * or decorative headers that clean to nothing fall through to the next block.
 *
 * @param {unknown} text raw text.
 * @returns {string|null} cleaned first paragraph, or null when nothing survives.
 */
export function firstParagraph(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const normalized = text.replace(/\r\n?/g, '\n')
  for (const block of normalized.split(/\n[ \t]*\n/)) {
    const cleaned = cleanMarkdownText(block)
    if (cleaned) return cleaned
  }
  const cleaned = cleanMarkdownText(normalized)
  return cleaned || null
}

/**
 * Extract the first text paragraph from assistant-message content blocks.
 *
 * @param {unknown} contentBlocks `event.data.message.content`-shaped array.
 * @returns {string|null} cleaned first paragraph, or null when the message has
 *   no non-empty `text` block.
 */
export function extractFirstTextParagraph(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return null
  const parts = []
  for (const block of contentBlocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.trim()) parts.push(block.text)
  }
  if (parts.length === 0) return null
  return firstParagraph(parts.join('\n\n'))
}

/**
 * Collapse every whitespace run (including newlines) into one space and trim.
 *
 * @param {unknown} text raw text.
 * @returns {string} single-line text; '' for non-string input.
 */
export function toSingleLine(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Truncate to at most `n` Unicode code points, marking the cut with '…'.
 *
 * The ellipsis is counted in the budget: the result never has more than `n`
 * code points. A limit of 0 returns ''; a limit of 1 returns '…'.
 *
 * @param {unknown} text raw text.
 * @param {number} n maximum code points in the result.
 * @returns {string} possibly truncated text.
 */
export function truncateCodepoints(text, n) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const limit = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
  const points = Array.from(text)
  if (points.length <= limit) return text
  if (limit <= 0) return ''
  return points.slice(0, limit - 1).join('') + '…'
}
