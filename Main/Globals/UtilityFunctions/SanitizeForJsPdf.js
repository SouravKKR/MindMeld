/**
 * sanitizeForJsPdf
 *
 * jsPDF's built-in fonts (Helvetica / Times / Courier) ship with the
 * WinAnsi (CP1252) encoding, which covers ASCII + Latin-1 Supplement +
 * a handful of CP1252 extras. Anything outside that set — Greek
 * letters, superscripts beyond ¹²³, the superscript minus, most math
 * operators, arrows, em-dashes used as subscript markers, etc. — comes
 * out as garbage (often as ampersand-bracketed glyphs with the rest of
 * the text spaced apart by replacement chars).
 *
 * The HTML preview renders correctly because the browser falls back to
 * Unicode-capable webfonts. PDF export does not have that luxury.
 *
 * This helper maps every common non-WinAnsi character that shows up in
 * generated mock-test questions to a readable ASCII (or WinAnsi)
 * equivalent. Anything still left outside WinAnsi after the explicit
 * mapping is replaced with '?' so jsPDF cannot trip on it.
 *
 * The mapping is intentionally conservative — characters that ARE in
 * WinAnsi (°, ², ³, ±, ×, ÷, ¹, æ, etc.) are passed through unchanged.
 * Only the truly-problematic ones get rewritten.
 */

const CHARACTER_MAP =
{
    // Superscripts not in WinAnsi (¹ ² ³ are; rest are not)
    "⁰": "^0",   // ⁰
    "⁴": "^4",   // ⁴
    "⁵": "^5",   // ⁵
    "⁶": "^6",   // ⁶
    "⁷": "^7",   // ⁷
    "⁸": "^8",   // ⁸
    "⁹": "^9",   // ⁹
    "⁺": "^+",   // ⁺
    "⁻": "^-",   // ⁻
    "⁼": "^=",   // ⁼
    "⁽": "^(",   // ⁽
    "⁾": "^)",   // ⁾
    "ⁿ": "^n",   // ⁿ

    // Subscripts (none of these are in WinAnsi)
    "₀": "_0",   // ₀
    "₁": "_1",   // ₁
    "₂": "_2",   // ₂
    "₃": "_3",   // ₃
    "₄": "_4",   // ₄
    "₅": "_5",   // ₅
    "₆": "_6",   // ₆
    "₇": "_7",   // ₇
    "₈": "_8",   // ₈
    "₉": "_9",   // ₉
    "₊": "_+",   // ₊
    "₋": "_-",   // ₋
    "₌": "_=",   // ₌
    "₍": "_(",   // ₍
    "₎": "_)",   // ₎

    // Greek lowercase (commonly used in science)
    "α": "alpha",     "β": "beta",      "γ": "gamma",
    "δ": "delta",     "ε": "epsilon",   "ζ": "zeta",
    "η": "eta",       "θ": "theta",     "ι": "iota",
    "κ": "kappa",     "λ": "lambda",    "μ": "mu",
    "ν": "nu",        "ξ": "xi",        "ο": "o",
    "π": "pi",        "ρ": "rho",       "σ": "sigma",
    "ς": "sigma",     "τ": "tau",       "υ": "upsilon",
    "φ": "phi",       "χ": "chi",       "ψ": "psi",
    "ω": "omega",

    // Greek uppercase
    "Α": "Alpha",     "Β": "Beta",      "Γ": "Gamma",
    "Δ": "Delta",     "Ε": "Epsilon",   "Ζ": "Zeta",
    "Η": "Eta",       "Θ": "Theta",     "Ι": "Iota",
    "Κ": "Kappa",     "Λ": "Lambda",    "Μ": "Mu",
    "Ν": "Nu",        "Ξ": "Xi",        "Ο": "O",
    "Π": "Pi",        "Ρ": "Rho",       "Σ": "Sigma",
    "Τ": "Tau",       "Υ": "Upsilon",   "Φ": "Phi",
    "Χ": "Chi",       "Ψ": "Psi",       "Ω": "Omega",

    // Math operators / relations
    "∂": "d",         // ∂  partial derivative — most readable as plain d
    "∇": "grad",      // ∇
    "∑": "Sum",       // ∑
    "∏": "Prod",      // ∏
    "∫": "Int",       // ∫
    "√": "sqrt",      // √
    "∞": "inf",       // ∞
    "≈": "~",         // ≈
    "≠": "!=",        // ≠
    "≡": "===",       // ≡
    "≤": "<=",        // ≤
    "≥": ">=",        // ≥
    "≪": "<<",        // ≪
    "≫": ">>",        // ≫
    "⊕": "(+)",       // ⊕
    "⊗": "(x)",       // ⊗
    "⋅": ".",         // ⋅ dot
    "−": "-",         // − (minus sign, vs hyphen)
    "′": "'",         // ′ prime
    "″": "''",        // ″ double prime

    // Arrows
    "←": "<-",        // ←
    "↑": "^",         // ↑
    "→": "->",        // →
    "↓": "v",         // ↓
    "↔": "<->",       // ↔
    "⇒": "=>",        // ⇒
    "⇔": "<=>",       // ⇔
    "⤳": "->",        // ⤳

    // Smart quotes / typographic dashes (some of these ARE in WinAnsi
    // already — included here for safety so the same helper is enough
    // even if the input mixes Unicode and WinAnsi forms).
    "‘": "'",         // ‘
    "’": "'",         // ’
    "“": "\"",        // “
    "”": "\"",        // ”
    "…": "...",       // …
    "–": "-",         // – en dash
    "—": "--",        // — em dash

    // Bullets / list markers
    "•": "*",         // •
    "●": "*",         // ●
    "◦": "o",         // ◦
    "■": "[]",        // ■
};


/**
 * Returns a copy of `rawText` safe to pass to jsPDF's standard fonts.
 * Characters explicitly mapped above are substituted; any other char
 * outside the printable WinAnsi range (0x20-0xFF) is replaced with '?'
 * so jsPDF cannot fall back to broken glyphs.
 *
 * Tabs and newlines are preserved.
 *
 * @param {*} rawText
 * @returns {string}
 */
function sanitizeForJsPdf(rawText)
{
    if (rawText === null || rawText === undefined)
    {
        return "";
    }

    const sourceText = String(rawText);
    let output = "";

    for (const character of sourceText)
    {
        if (CHARACTER_MAP[character] !== undefined)
        {
            output += CHARACTER_MAP[character];
            continue;
        }

        const codePoint = character.codePointAt(0);

        // Keep ASCII printables, tab, newline, and the Latin-1 supplement.
        // WinAnsi additionally includes a handful of glyphs in 0x80-0x9F
        // (Euro, smart quotes, etc.); those are mapped above or fall
        // through to the unknown branch.
        if (codePoint === 0x09 || codePoint === 0x0A || codePoint === 0x0D)
        {
            output += character;
            continue;
        }
        if (codePoint >= 0x20 && codePoint <= 0x7E)
        {
            output += character;
            continue;
        }
        if (codePoint >= 0xA0 && codePoint <= 0xFF)
        {
            output += character;
            continue;
        }

        // Unknown — replace with '?' so jsPDF does not see anything it
        // cannot render. Keeps the rest of the line intact.
        output += "?";
    }

    return output;
}

export default sanitizeForJsPdf;
