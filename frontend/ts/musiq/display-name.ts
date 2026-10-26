/** Display-only rules mirrored in core/musiq/display_name.py and shared fixtures. */
const separator = /\s+[-–—|]\s+/;
const quality = '(?:music\\s+)?(?:hq|hd|flac|lossless|[48]k|\\d{3,4}p)';
const junk = new RegExp('^(?:(?:(?:official|unofficial)\\s+)?' +
  '(?:(?:music|lyric|lyrics)\\s+)?(?:video|audio|visuali[sz]er|lyrics?)' +
  '(?:\\s+' + quality + ')?|' + quality + '(?:[\\s/,+–—-]+' + quality + ')*|' +
  '(?:high[\\s-]*speed|sped[\\s-]*up)\\s*(?:version|ver\\.?)?|bonus\\s+tracks?)$', 'i');
const text = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const key = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function annotations(value: string): string {
  const pairs = new Map<string, string>([['(', ')'], ['[', ']'], ['{', '}'], ['【', '】'], ['〔', '〕'],
    ['「', '」'], ['『', '』'], ['〈', '〉'], ['《', '》']]);
  const closers = new Set(pairs.values());
  const stack: string[] = [], result: string[] = [];
  for (const char of value) {
    if (pairs.has(char)) {
      if (!stack.length) result.push(' ');
      stack.push(pairs.get(char));
    } else if (closers.has(char)) {
      if (stack.length && char === stack[stack.length - 1]) stack.pop();
    } else if (!stack.length) result.push(char);
  }
  return text(result.join(''));
}

function segments(title: string): {parts: string[], separators: string[]} {
  const parts: string[] = [], separators: string[] = [];
  let start = 0, cursor = 0, depth = 0;
  const pattern = new RegExp(separator.source, 'g');
  let match: RegExpExecArray;
  while ((match = pattern.exec(title))) {
    for (const char of title.slice(cursor, match.index)) depth = Math.max(0, depth + ('(['.includes(char) ? 1 : ')]'.includes(char) ? -1 : 0));
    cursor = pattern.lastIndex;
    if (depth) continue;
    parts.push(title.slice(start, match.index)); separators.push(match[0]); start = pattern.lastIndex;
  }
  parts.push(title.slice(start));
  return {parts, separators};
}

export function cleanDisplayNames(artist, title): {artist: string, title: string} {
  const rawTitle = text(title);
  title = annotations(rawTitle);
  const label = annotations(text(artist)).replace(/\s*[-–—]\s*Topic$|VEVO$/i, '').trim();
  const credits: string[] = [];
  const seen = new Map<string, number>();
  label.split(/[,;]/).forEach(value => {
    const credit = value.replace(/\s*[-–—]\s*Topic$|VEVO$/i, '').trim();
    const name = key(credit);
    if (name && !seen.has(name)) { seen.set(name, credits.length); credits.push(credit); }
  });
  const keys = new Set(seen.keys());
  if (credits.length) ['', ' x ', ' and '].forEach(joiner => keys.add(key(credits.join(joiner))));
  title = annotations(title);
  const {parts, separators} = segments(title);
  while (parts.length > 1 && junk.test(parts[parts.length - 1].trim())) { parts.pop(); separators.pop(); }
  while (parts.length > 1) {
    const knownCredit = value => keys.has(key(value)) || value.split(/[,;]/).every(part => seen.has(key(part)));
    const index = knownCredit(parts[0]) ? 0 : knownCredit(parts[parts.length - 1]) ? parts.length - 1 : -1;
    if (index < 0) break;
    const credit = parts.splice(index, 1)[0].trim();
    separators.splice(index === 0 ? 0 : separators.length - 1, 1);
    credit.split(/[,;]/).forEach(value => {
      const name = value.trim(), identity = key(name);
      if (seen.has(identity)) {
        const old = credits[seen.get(identity)];
        if (old === old.toLowerCase() && (name.includes(' ') || name !== name.toLowerCase())) credits[seen.get(identity)] = name;
      }
    });
  }
  title = parts.map((part, i) => part + (separators[i] || '')).join('') || title;
  return {artist: credits.join(', '), title: text(title)};
}

export function displayArtist(artist, title): string {
  return cleanDisplayNames(artist, title).artist;
}

export function displayName(song): string {
  const names = cleanDisplayNames(song.artist, song.title);
  return [names.artist, names.title].filter(Boolean).join(' – ');
}
