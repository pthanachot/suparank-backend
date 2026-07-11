# Rec 13 Phase A — scoring divergence table

Measured 2026-07-09 against a live engine (`/api/score`) with the 10 committed
fixtures. Regenerate: run the three parity legs (backend jest, frontend
vitest, writing-engine `go test -run TestScoringParity`) and re-read the three
`parity-report.*.json` artifacts.

## Overall score per fixture

| fixture           | backend | frontend | writing-engine |
|-------------------|--------:|---------:|---------------:|
| empty-short       |       3 |        0 |              0 |
| balanced-long     |      84 |       89 |             75 |
| inflected-forms   |      32 |       32 |             35 |
| short-term-trap   |      18 |       15 |             19 |
| unicode-headings  |      37 |       38 |             43 |
| tables-heavy      |      42 |       43 |             40 |
| faq-heavy         |      44 |       47 |             45 |
| keyword-stuffed   |      26 |       25 |             32 |
| overused-terms    |      27 |       28 |             31 |
| links-images      |      45 |       39 |             43 |

## Findings

1. **Term-count divergence (JS stemmer vs engine): 3/80 counts, all Δ1.**
   - `automate` (balanced-long 16→15, faq-heavy 6→5): a JS-porter inflection
     ("automatically" family) the Go stemmer treats differently. Same root
     cause as the pre-existing `internal/nlp` test failures
     (`Stem("refinance") = "refin"` vs `"refinanc"`).
   - `subscriber segmentation` (unicode-headings 2→1): CJK/latin token
     boundary — `購読者のsubscriber` splits differently between the JS and Go
     tokenizers.
   - **Phase B neutralizes this class in the backend** by injecting engine
     counts; the frontend already does (useEngineTermCounts).

2. **Frontend <50-word early return**: `scoreContent.ts` returns zero signals
   under 50 words; backend scorer.js scores short drafts fully (19 signals,
   score 3). Behavioral, not numeric — decide the canonical rule in Phase C.

3. **Backend ↔ frontend track within ±6** across all fixtures (typical ±2-3).
   Largest: links-images (45 vs 39 — internal-links signal is optional on the
   frontend), balanced-long (84 vs 89).

4. **Writing-engine is the outlier: up to Δ14** (balanced-long 75 vs 89).
   Different signal set (5 grouped scores + link report), different length
   curve, markdown-native counting (`countMarkdownTables` vs `<table>`),
   different anti-stuffing response (keyword-stuffed scores 32 vs 25-26 —
   most lenient of the three).

## Phase C gate status

Plan gate: |Δ overallScore| ≤ 2 across all fixtures before cutover.
**Current max Δ = 14 → Phase C is BLOCKED**, as expected. The consolidation
must adopt one canonical signal set (plan: writing-engine's `ScoreReport`
schema with the backend/frontend's 19-signal math) and re-run this table
until the gate passes.
