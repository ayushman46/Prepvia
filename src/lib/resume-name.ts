/**
 * Find the candidate's name in resume text (as extracted from the PDF, one line per
 * text line), to fill in the setup form. Resumes put the name first in almost every
 * layout; sidebars and "Name:" forms are handled too. Returns null rather than a
 * wrong guess: the candidate types their name when nothing confident is found.
 */

const MAX_LINES = 15;

// Words that make a short capitalised line a heading, job title, place or skill, not a name.
const NOT_NAME = new Set(
  (
    "resume curriculum vitae cv bio biodata profile summary objective about me contact contacts details personal info information " +
    "experience work employment history education skills skill technical projects project certifications awards achievements languages interests hobbies references publications " +
    "email phone mobile tel address linkedin github portfolio website location " +
    "engineer engineering developer development manager designer scientist analyst consultant architect intern student graduate specialist " +
    "lead principal senior junior staff head director officer executive associate assistant administrator coordinator " +
    "software hardware frontend front backend back full stack data product project program marketing sales business finance operations " +
    "machine learning ai ml devops cloud security mobile web qa test quality research " +
    "react typescript javascript python java golang go kafka node aws azure gcp sql docker kubernetes " +
    "india usa uk inc ltd llc pvt university college institute school"
  ).split(" "),
);

// A name word: Title-case (with O'Neil / Garcia-Lopez style joins), ALL CAPS, or an initial.
const NAME_WORD = /^(?:\p{Lu}\p{Ll}*(?:['’-]\p{Lu}?\p{Ll}+)*|\p{Lu}{2,}(?:['’-]\p{Lu}+)*|\p{Lu}\.)$/u;
// Credentials and suffixes after a name: "John O'Neil, PhD".
const SUFFIX = /,?\s+(?:ph\.?\s?d\.?|mba|md|cpa|pmp|cfa|msc|ms|ma|bsc|bs|ba|b\.?\s?tech|m\.?\s?tech|be|me|jr\.?|sr\.?|ii|iii|iv)$/i;
// Separators between a name and the rest of a header line.
const SEPARATOR = /\s+[|•·—–-]\s+|\s*[|•·]\s*|\s{3,}|\t/;
const SECTION = /^(?:contact|skills?|technical skills|experience|work experience|education|projects?|summary|profile|objective|certifications?|languages|interests|references)\s*:?$/i;
const LABELLED = /^(?:full\s+)?name\s*[:\-–]\s*(.+)$/i;

function titleCase(word: string): string {
  if (/^\p{Lu}\.$/u.test(word) || word !== word.toUpperCase()) return word;
  return word.toLowerCase().replace(/(^|['’-])(\p{Ll})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase());
}

/** The line as a name ("Priya Raman"), or null if it doesn't look like one. */
function asName(line: string): string | null {
  const head = line.split(SEPARATOR)[0]?.trim().replace(SUFFIX, "").trim() ?? "";
  if (!head || head.length > 60 || /[\d@/:]|https?|www\./i.test(head)) return null;
  const words = head.split(/\s+/);
  if (words.length < 2 || words.length > 4) return null;
  if (!words.every((word) => NAME_WORD.test(word))) return null;
  if (words.some((word) => NOT_NAME.has(word.toLowerCase().replace(/[.'’]/g, "")))) return null;
  if (words.filter((word) => /^\p{Lu}\.$/u.test(word)).length > 1 && words.length < 3) return null;
  return words.map(titleCase).join(" ");
}

/** Lowercase letters of the email addresses in the text ("priya.raman@gmail.com" → "priyaramangmailcom"). */
function emailLetters(text: string): string[] {
  return (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map((email) => email.toLowerCase().replace(/[^a-z]/g, ""));
}

export function extractCandidateName(text: string | null | undefined): string | null {
  const lines = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_LINES);
  for (const line of lines) {
    const labelled = LABELLED.exec(line);
    if (labelled) {
      const name = asName(labelled[1]);
      if (name) return name;
    }
  }
  const emails = emailLetters(text ?? "");
  let best: { name: string; score: number } | null = null;
  let inSection = false;
  for (const [index, line] of lines.entries()) {
    if (SECTION.test(line)) {
      inSection = true;
      continue;
    }
    const name = asName(line);
    if (!name) continue;
    const parts = name.toLowerCase().split(" ").filter((part) => part.replace(/[^a-z]/g, "").length > 1);
    const inEmail = emails.some((email) => parts.filter((part) => email.includes(part.replace(/[^a-z]/g, ""))).length >= Math.min(2, parts.length));
    // Earlier is likelier; a name matching an email address is near-certain; a capitalised
    // line inside a section (a sidebar's skills, a company) is not, unless the email agrees.
    const score = 10 - index + (inEmail ? 6 : 0) - (inSection ? 8 : 0);
    if (score > 0 && (!best || score > best.score)) best = { name, score };
  }
  return best?.name ?? null;
}
