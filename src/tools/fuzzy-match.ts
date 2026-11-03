export interface FuzzyMatch {
  start: number;

  end: number;

  matched: string;

  strategy: "exact" | "whitespace" | "line-trimmed" | "indentation";
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    n += 1;
    from = i + needle.length;
  }
  return n;
}

function exactMatch(text: string, needle: string): FuzzyMatch | null {
  const i = text.indexOf(needle);
  if (i === -1) return null;
  return { start: i, end: i + needle.length, matched: needle, strategy: "exact" };
}

function whitespaceMatch(text: string, needle: string): FuzzyMatch | null {
  const normNeedle = needle
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
  if (normNeedle.length === 0) return null;

  let norm = "";
  const map: number[] = [];
  let i = 0;
  let pendingSpace: number | null = null;
  for (; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === " " || c === "\t") {
      if (pendingSpace === null) pendingSpace = i;
      continue;
    }
    if (pendingSpace !== null && norm.length > 0) {
      norm += " ";
      map.push(pendingSpace);
    }
    pendingSpace = null;
    norm += c;
    map.push(i);
  }
  const normText = norm.replace(/\n /g, "\n");

  const collapsed: string[] = [];
  const collapsedMap: number[] = [];
  for (let k = 0; k < norm.length; k += 1) {
    const c = norm[k]!;
    if (c === " " && norm[k - 1] === "\n") continue;
    collapsed.push(c);
    collapsedMap.push(map[k]!);
  }
  const hay = collapsed.join("");
  const idx = hay.indexOf(normNeedle.replace(/ ?\n ?/g, "\n"));
  if (idx === -1) return null;
  void normText;
  const start = collapsedMap[idx]!;
  const endOrig = collapsedMap[idx + normNeedle.replace(/ ?\n ?/g, "\n").length - 1]!;
  return {
    start,
    end: endOrig + 1,
    matched: text.slice(start, endOrig + 1),
    strategy: "whitespace"
  };
}

function lineTrimmedMatch(text: string, needle: string): FuzzyMatch | null {
  const needleLines = needle.split("\n").map((l) => l.trim());
  const textLines = text.split("\n");
  for (let start = 0; start + needleLines.length <= textLines.length; start += 1) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j += 1) {
      if (textLines[start + j]!.trim() !== needleLines[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Offsets must be computed on the original text so the returned span
    // includes the real leading whitespace and exact length of the match.
    let offset = 0;
    for (let k = 0; k < start; k += 1) offset += textLines[k]!.length + 1;
    const startOffset = offset;
    const endOffset = startOffset + textLines.slice(start, start + needleLines.length).join("\n").length;
    return {
      start: startOffset,
      end: endOffset,
      matched: text.slice(startOffset, endOffset),
      strategy: "line-trimmed"
    };
  }
  return null;
}

function indentationMatch(text: string, needle: string): FuzzyMatch | null {
  const strip = (s: string): string =>
    s
      .split("\n")
      .map((l) => l.replace(/^\s+/, ""))
      .join("\n");
  const needleStripped = strip(needle).trim();
  if (needleStripped.length === 0) return null;
  const needleLines = needleStripped.split("\n");
  // Compare against the text with every leading run of whitespace removed,
  // and keep a per-character offset map back into the original text so the
  // returned span covers the exact block (regression: slicing text with
  // offsets derived from the stripped string replaced only a prefix).
  const rawLines = text.split("\n");
  const textLines = rawLines.map((l) => l.replace(/^\s+/, ""));
  for (let start = 0; start + needleLines.length <= textLines.length; start += 1) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j += 1) {
      if (textLines[start + j] !== needleLines[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let offset = 0;
    for (let k = 0; k < start; k += 1) offset += rawLines[k]!.length + 1;
    const startOffset = offset;
    const matchedLines = rawLines.slice(start, start + needleLines.length);
    const endOffset = startOffset + matchedLines.join("\n").length;
    return {
      start: startOffset,
      end: endOffset,
      matched: text.slice(startOffset, endOffset),
      strategy: "indentation"
    };
  }
  return null;
}

export function findFuzzy(
  text: string,
  needle: string
): { match: FuzzyMatch | null; ambiguous: boolean } {
  if (needle.length === 0) return { match: null, ambiguous: false };
  const exact = exactMatch(text, needle);
  if (exact) {
    return { match: exact, ambiguous: countOccurrences(text, needle) > 1 };
  }
  for (const strategy of [whitespaceMatch, lineTrimmedMatch, indentationMatch]) {
    const m = strategy(text, needle);
    if (m) {
      const occurrences = countOccurrences(text, m.matched);
      return { match: m, ambiguous: occurrences > 1 };
    }
  }
  return { match: null, ambiguous: false };
}
