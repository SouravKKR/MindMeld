# LDNOOBW — List of Dirty, Naughty, Obscene, and Otherwise Bad Words

The banned-term source for the Agent's content guardrail
([ContentGuardrail.py](../../Globals/Classes/Compliance/ContentGuardrail.py)). Vendored, never fetched
at runtime — the Agent must never make a network call to a third-party host to decide whether a
model's answer is publishable.

| | |
|---|---|
| Version | `4638b970cb8d9d82789564fcba1f4a1eb508ff1a` — a word list has no release number, so the upstream commit is the version, and it is in the filename on purpose (see Upgrading below) |
| File | `en-4638b970.txt` — the English list only |
| Source | `https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words`, path `en` (originally published by Shutterstock) |
| Retrieved | 2026-08-06 |
| License | Creative Commons Attribution 4.0 International — https://creativecommons.org/licenses/by/4.0/ |
| Contents | 403 terms, 124 of them multi-word phrases, one per line, LF-terminated, lowercase |

**Unmodified from upstream.** The file is byte-identical to the source commit
(sha256 `af851ecef1d5f212caba17339b12ac39cc2fef7d78c74876f67237644fcee8bd`). CC-BY 4.0 §3(a)(1)(B)
requires indicating whether the work was modified, so nothing is edited here — every exclusion the
guardrail applies lives in code and in a separate file we own,
[AcademicTermAllowlist.txt](../../Globals/Classes/Compliance/AcademicTermAllowlist.txt).

## Why only `en`

The Agent's prompts are English-first and the verification model reasons about intent best in English.
The non-English LDNOOBW lists are smaller, less curated, and contain terms that are innocuous words in
another language — folding them all into one pattern produces cross-language false positives on English
text. Adding a language later is one committed file plus one entry in
`BannedTermLexicon.WORD_LIST_FILE_NAMES`.

## What the guardrail does with it

Two entries need care and the lexicon handles them explicitly rather than by editing this file:

- `s&m` — contains word characters at both ends, so the normal `(?<!\w) … (?!\w)` anchoring is correct.
- `🖕` — contains no word characters at all, so word-boundary anchoring would make it unmatchable next
  to a letter. Entries like this are compiled into a separate un-anchored alternation.

Terms are matched whole-word only, with no stemming: `shit` does not match `shitake`, `cunt` does not
match `Scunthorpe`, and `anal` does not match `analysis`. Inflections are covered only where upstream
ships them (`bitch` and `bitches` are both present).

## Upgrading

1. Fetch the new `en` from the upstream commit you want to pin.
2. Save it as `en-<short-sha>.txt` and **delete the previous file** — the lexicon globs `en-*.txt` and
   would otherwise merge two generations of the list.
3. Update the Version, Retrieved and sha256 rows above.
4. Re-run `python Agent/Verification/VerifyContentGuardrail.py`. It asserts against specific terms, so
   an upstream removal shows up as a failing assertion rather than a silent loss of coverage.
5. Re-check [AcademicTermAllowlist.txt](../../Globals/Classes/Compliance/AcademicTermAllowlist.txt) —
   its entries must still exist verbatim upstream, and new upstream terms may need allowlisting.
6. The Agent Docker image bakes this file in (`COPY . /app/Agent`), so a change needs a fresh burst
   worker Image — deploy without `--skip-bake`.
