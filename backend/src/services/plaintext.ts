/**
 * The text without `<...>` markup. One pass can leave a tag behind (`<<b>script>` becomes `<script>`),
 * so it goes on until nothing changes; the innermost tag goes first. What is left is only ever shown as text.
 */
export function stripTags(s: string): string {
  let t = s
  for (;;) {
    const next = t.replace(/<[^<>]*>/g, '')
    if (next === t) return t
    t = next
  }
}
