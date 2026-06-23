

function diceBigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    m.set(bg, (m.get(bg) ?? 0) + 1);
  }
  return m;
}

export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = diceBigrams(a);
  const B = diceBigrams(b);
  let inter = 0;
  let totalA = 0;
  let totalB = 0;
  for (const [, v] of A) totalA += v;
  for (const [bg, v] of B) {
    totalB += v;
    const av = A.get(bg);
    if (av !== undefined) inter += Math.min(av, v);
  }
  return (2 * inter) / (totalA + totalB || 1);
}


export function jaroWinkler(a: string, b: string, p = 0.1): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aLen = a.length;
  const bLen = b.length;
  const matchDistance = Math.max(0, Math.floor(Math.max(aLen, bLen) / 2) - 1);
  const aMatches = new Array<boolean>(aLen).fill(false);
  const bMatches = new Array<boolean>(bLen).fill(false);
  let matches = 0;
  for (let i = 0; i < aLen; i++) {
    const lo = Math.max(0, i - matchDistance);
    const hi = Math.min(bLen, i + matchDistance + 1);
    for (let j = lo; j < hi; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < aLen; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;
  const jaro =
    (matches / aLen + matches / bLen + (matches - transpositions) / matches) /
    3;
  let prefixLen = 0;
  for (let i = 0; i < Math.min(4, aLen, bLen); i++) {
    if (a[i] === b[i]) prefixLen++;
    else break;
  }
  return jaro + prefixLen * p * (1 - jaro);
}


export function tokenSetRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(/\s+/).filter(Boolean).sort();
  const tb = b.split(/\s+/).filter(Boolean).sort();
  if (ta.length === 0 || tb.length === 0) return 0;
  const A = new Set(ta);
  const B = new Set(tb);
  const inter = new Set<string>();
  for (const t of A) if (B.has(t)) inter.add(t);
  const diffA = [...A].filter((t) => !B.has(t)).join(" ");
  const diffB = [...B].filter((t) => !A.has(t)).join(" ");
  const interStr = [...inter].join(" ");
  const s1 = dice(interStr, `${interStr} ${diffA}`.trim());
  const s2 = dice(interStr, `${interStr} ${diffB}`.trim());
  const s3 = dice(`${interStr} ${diffA}`.trim(), `${interStr} ${diffB}`.trim());
  return Math.max(s1, s2, s3);
}


export function charNgramJaccard(a: string, b: string, n = 3): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < n || b.length < n) return 0;
  const A = new Set<string>();
  const B = new Set<string>();
  for (let i = 0; i <= a.length - n; i++) A.add(a.slice(i, i + n));
  for (let i = 0; i <= b.length - n; i++) B.add(b.slice(i, i + n));
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter || 1);
}


export function bestSim(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(
    dice(a, b),
    jaroWinkler(a, b),
    tokenSetRatio(a, b),
    charNgramJaccard(a, b, 3),
  );
}

export const compareTwoStrings = bestSim;
