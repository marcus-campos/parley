/**
 * This corpus is notes about code: `screen_builder.html`, `select2`,
 * `/setting/reference`, `is_staff()`. Queries against it are dense with
 * identifiers, which is exactly where exact-token matching is strongest.
 *
 * The compound is kept alongside its parts so that both `is_staff` and `staff`
 * find the same note.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/[\s(),;:"'`\[\]{}<>|!?]+/)) {
    if (!chunk) continue;
    const cleaned = chunk.replace(/^[./-]+|[./-]+$/g, "");
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    if (/[_\-./]/.test(lower) || /[a-z][A-Z]/.test(cleaned)) out.push(lower);
    for (const part of cleaned.split(/[_\-./]+/)) {
      if (!part) continue;
      for (const camel of part.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
        const token = camel.toLowerCase();
        if (token) out.push(token);
      }
    }
  }
  // Duplicates are kept on purpose: BM25 scores on term frequency.
  return out;
}
