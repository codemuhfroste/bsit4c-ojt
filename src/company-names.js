// Group detection for the MoA: when do two company names count as the same company? Kept free of the database so it
// can be tested on its own.

// Words that say what kind of legal entity it is, not which company: ignored when comparing names.
const IGNORED = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "llc",
  "the",
  "of",
  "and",
]);

const words = (name) =>
  String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !IGNORED.has(w));

function editDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1); // one letter changed
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.slice(i) === long.slice(i + 1); // one letter added
}

// Two words match when they are the same, or (for longer words) one typo or plural apart.
const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && editDistanceAtMostOne(a, b));

// "Word for word the same, or one word different":
//  - same words (case, punctuation and "Inc." ignored);
//  - one extra word on either side ("Quanby Solutions" / "Quanby Solutions Philippines");
//  - one different word, but only in longer names (four words or more), so "DTI" and "PNB", or "Globe Telecom" and
//    "Smart Telecom", are never mistaken for the same company.
// The first word is the company's name, so it must always match: "PhilHealth Regional Office V" and "BFP Regional
// Office V" share all but one word, yet they are different agencies.
export function similarCompany(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length || !sameWord(x[0], y[0])) return false;
  if (x.length === y.length) {
    const different = x.filter((w, i) => !sameWord(w, y[i])).length;
    return different === 0 || (different === 1 && x.length >= 4);
  }
  if (Math.abs(x.length - y.length) !== 1) return false;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return long.some((_, skip) => long.filter((_, i) => i !== skip).every((w, i) => sameWord(w, short[i])));
}
