const WORD = /[\p{L}\p{N}_]/u;

/**
 * People mentioned as "@Full Name" in a comment. The name must stand on its own
 * (not be the start of a longer word) so "@Ann" does not match "@Annabel".
 */
export function findMentions<T extends { id: string; name: string }>(
  text: string,
  candidates: T[],
): T[] {
  const lower = text.toLowerCase();
  return candidates.filter((user) => {
    const token = `@${user.name.toLowerCase()}`;
    let at = lower.indexOf(token);
    while (at >= 0) {
      const before = at === 0 ? '' : lower[at - 1];
      const after = lower[at + token.length] ?? '';
      if (!WORD.test(before) && !WORD.test(after)) return true;
      at = lower.indexOf(token, at + 1);
    }
    return false;
  });
}
