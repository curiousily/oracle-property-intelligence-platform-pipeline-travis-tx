const LEADING_ARTICLE = "the";
const CONJUNCTION = "and";
const TRAILING_NOISE = new Set([
  "llc",
  "inc",
  "incorporated",
  "co",
  "corp",
  "corporation",
  "company",
  "companies",
  "ltd",
  "lp",
  "llp",
  "pllc",
  "pc",
  "main",
]);
const HOME_STATE_SUFFIXES = new Set(["texas", "tx"]);
const STATE_SUFFIX_PREPOSITION = "of";
const PHONE_DIGITS = 10;

export function companyKey(name: string | undefined): string | undefined {
  const tokens = (name ?? "")
    .toLowerCase()
    .replaceAll("&", ` ${CONJUNCTION} `)
    .replaceAll(".", "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token !== "" && token !== CONJUNCTION);

  if (tokens[0] === LEADING_ARTICLE) tokens.shift();
  let trimmed = true;
  while (trimmed && tokens.length > 0) {
    trimmed = false;
    const last = tokens.at(-1) ?? "";
    if (TRAILING_NOISE.has(last)) {
      tokens.pop();
      trimmed = true;
    } else if (HOME_STATE_SUFFIXES.has(last) && tokens.at(-2) === STATE_SUFFIX_PREPOSITION) {
      tokens.splice(-2);
      trimmed = true;
    }
  }

  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

export function phoneKey(phone: string | undefined): string | undefined {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= PHONE_DIGITS ? digits.slice(-PHONE_DIGITS) : undefined;
}
