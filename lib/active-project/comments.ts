/**
 * LaTeX comment stripping.
 *
 * Two kinds of comments handled:
 *   - Line comments: `%` to end of line, respecting `\%` (escaped percent).
 *     A `%` is a comment marker iff it is preceded by an even number of
 *     backslashes (zero counts as even). `\%` -> literal percent. `\\%` -> backslash
 *     followed by comment marker.
 *   - Block comments: `\begin{comment}...\end{comment}` from the `comment` package.
 *
 * NOT handled (intentional):
 *   - Conditional compilation: `\iffalse...\fi`, `\if@journal...\fi`. These
 *     require running TeX to evaluate. The walker treats anything inside as
 *     live code. Documented limitation.
 *   - User-defined macro expansion: `\newcommand{\myinput}[1]{\input{#1}}` then
 *     `\myinput{x}`. Same reason.
 */

export function stripLatexComments(content: string): string {
  // 1. Strip block comments first (the `comment` package).
  //    Multi-line. Greedy across whitespace+content but lazy on the closer.
  const noBlocks = content.replace(/\\begin\{comment\}[\s\S]*?\\end\{comment\}/g, '')

  // 2. Strip line comments line by line, respecting `\%` escape.
  return noBlocks.split('\n').map(stripLineComment).join('\n')
}

function stripLineComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') continue
    // Count consecutive backslashes immediately before this `%`.
    let backslashes = 0
    let j = i - 1
    while (j >= 0 && line[j] === '\\') {
      backslashes++
      j--
    }
    // Even backslashes (incl. 0) means the `%` is a real comment marker.
    if (backslashes % 2 === 0) return line.slice(0, i)
    // Odd → escaped percent; keep scanning past it.
  }
  return line
}
