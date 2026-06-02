# Simulation Report Redesign — Design

**Date:** 2026-05-31
**Branch context:** RES-846 (HTML + Markdown report export for agent simulation)
**Status:** Approved design, pending spec review

## Problem

The agent-simulation HTML/Markdown report (added in RES-846) is a data dump:
~11 near-identical tables, two small default-styled charts, failures buried at
the bottom, and raw criterion IDs (`criteria_0`) instead of human-readable rule
descriptions. A four-persona visual review (research engineer, eng manager,
QA/red-team analyst, designer) converged on the same gaps:

- **No headline.** The 25%-success verdict is a table cell, not a scannable
  result. No hero/scorecard, no pass/fail badge.
- **Failures hidden.** NOT-ACHIEVED conversations are mixed with passes in a
  flat bottom list; no failures-first view.
- **`criteria_0` is unusable.** `sections.py` counts raw `rules_broken` IDs and
  never joins `Criterion.description`. The per-criterion pass/fail data
  (`criteria_results`, description→bool) is already collected but never rendered.
- **No failure-analysis charts.** No criteria heatmap, no persona×scenario
  matrix, no score distribution, no turn-quality timeline.
- **Visual quality 3/10.** Teal-table monotony, no semantic status color, charts
  undersized/unstyled, mobile = crushed desktop.
- **Bugs.** `Model: unknown` on every conversation; transcripts truncated with a
  misleading "full text in report JSON" note pointing at nothing.

## Goals

1. Turn the static report into a designed, scannable artifact: hero scorecard,
   card sections, semantic status colors, failures-first, mobile-friendly.
2. Add failure-analysis visuals: criteria heatmap, persona×scenario heatmap,
   goal-score distribution, turn-quality timeline, failure-mode bar/matrix.
3. Fix the `criteria_0` bug and the `Model: unknown` / truncation bugs.
4. Share the work in `common.reports` so the redteam static report inherits the
   visual upgrade and the dependency reduction.

## Non-goals (YAGNI)

- **Interactivity** (filter/sort/zoom/hover-drill). The static report is a
  portable snapshot; interactive exploration is the dashboard's job.
- **Interactive Streamlit dashboard for simulation.** Deferred to its own
  follow-up spec (mirror `redteam/ui/dashboard.py`). This is where treemap,
  hover-detail, and live filtering belong.
- **Trend-over-runs.** Requires multi-run history we do not persist. Future.

## Key architectural decision: hand-authored SVG, plotly optional

The static report renders **all charts as hand-authored SVG/CSS** — no plotly,
no kaleido. Rationale:

- The static report's job is a self-contained, portable snapshot (attach to PR,
  email, commit, archive). Static SVG via kaleido pays a heavy, CI-flaky native
  dependency to produce a non-interactive picture — all cost, none of the
  interactivity benefit.
- Hand-SVG is fully self-contained, tiny, deterministic, brand-styleable
  exactly, and removes the native dependency from the report path entirely.
- Charts that genuinely need interactivity (treemap drill-down, hover values on
  dense matrices) belong in the future dashboard with real plotly.js.

Consequences:
- `plotly` / `kaleido` revert to **optional** (`ui` / `export` extras only).
  The hard-dependency change is reverted.
- New hand-SVG primitives are added to `common.reports` under **new names**
  (additive). The simulation report uses only these — it imports no plotly. The
  existing plotly-based helpers (`render_donut_chart`,
  `render_horizontal_bar_chart`, `charts_available`, `try_render_svg`) are left
  in place untouched, because redteam still uses them and its own inline plotly
  charts. We do **not** reimplement them in place — that would risk a redteam
  regression for no benefit to simulation.
- **Treemap is dropped from the static report.** Priya's failure-mode-clustering
  need is met with a hand-SVG failure-mode bar/matrix (failed-criteria counts by
  scenario). Treemap is noted for the dashboard spec.

> **Adversarial-review correction (do not re-introduce):** an earlier draft
> claimed redteam would "inherit the dependency drop" by reimplementing the two
> shared helpers as hand-SVG. That is false. `redteam/reports/export_html.py`
> renders most of its charts with its **own** inline plotly (`go.Figure` /
> `go.Pie` in `_render_severity_bar_chart`, `_render_category_bar_chart`, and
> several more), gated on `charts_available()`. Swapping the two shared helpers
> drops nothing for redteam. Redteam's plotly dependency and graceful-degrade
> behaviour stay exactly as they are this round (see Layer 5).

## Architecture (Approach A: section-kind extension)

Keep the existing layered pipeline. `sections.py` remains the shared,
renderer-agnostic data layer producing `ReportSection(kind, title, data)`.
Renderers dispatch by `kind`. We add new kinds, new hand-SVG primitives, and a
hero+card HTML layout. Markdown stays linear.

### Layer 1 — `common.reports` (shared)

**Palette consolidation.** Move the brand palette from
`redteam/ui/colors.py` into `common.reports` (new `palette.py` or extend
existing color exports): `SEVERITY_COLORS`, `SEVERITY_ORDER`, `QUALITATIVE`,
`ORQ_SCALE_GOOD_BAD`, `ORQ_SCALE_HEAT`, `ORQ_SCALE_AGENT`. Keep existing
`COLORS` / `STATUS_COLORS`. `redteam/ui/colors.py` re-exports from common for
back-compat.

**New hand-SVG/CSS primitives in `html_helpers.py`** (pure string builders, no
plotly; new names, additive — the existing plotly helpers are left untouched for
redteam):
- `svg_donut(...)` — hand-SVG donut (arc paths) with a center label
  (e.g. "25%"). Used by the simulation summary/hero.
- `svg_bar(...)` — hand-SVG bar chart with value labels.
- `render_heatmap(x_labels, y_labels, cells, *, scale, title, value_fmt)` —
  color-filled grid with in-cell value text from a discrete/continuous brand
  scale; supports a per-cell flag for "safety" (must_not_happen) coloring.
  **Reference implementation:** mirror redteam's existing hand-rolled
  `_render_attack_heatmap_html` (`redteam/reports/export_html.py:635`) — colored
  `<td>` cells with `background:{color}` and a `.heatmap-table` CSS class. Use
  that pattern (HTML table of colored cells) rather than inventing a new SVG
  grid, and promote the `.heatmap-table` / `.heatmap-cell` CSS into the shared
  `report.css` so both reports use one definition.
- `render_histogram(values, *, bins, title)` — bar SVG of binned counts.
- `render_line_chart(x_labels, series, *, title)` — polyline SVG for the
  turn-quality timeline (one line per metric).
- `render_sparkline(values)` — inline mini-bar/line SVG for table rows.
- `kpi_cards(cards)` — HTML card band; each card `{label, value, status}` →
  big-number card with semantic accent.
- `status_badge(text, status)` — semantic pill (`pass`/`fail`/`warn`).

All primitives accept a small fixed pixel size and inline their styles/classes
so they render identically offline. A continuous color helper
(`scale_color(value, scale)`) interpolates the brand scales for heatmap cells.

**`render.py` — hero + card layout.** Add an HTML body composer that emits a
hero header (title + KPI band) and wraps each section in a `.report-card`. The
section→renderer dispatch is unchanged; the composer decides card grouping and
order. Markdown composer stays linear.

**`report.css` overhaul.** CSS custom properties for semantic colors; `.hero`,
`.kpi-card`, `.report-card`, `.chart-card`, `.status-pass/.status-fail/.status-warn`,
`.sparkline`, heatmap cell classes; a type scale (display number / section /
label / body) with tabular figures for numeric columns; `@media (max-width:
640px)` that stacks wide tables into label/value cards.

**`md_helpers.py`.** Text equivalents: heatmap → compact table (✓/✗ or
rate), badges → emoji/text, distribution → bar rows. No visual regressions to
existing MD sections.

### Layer 2 — `simulation/reports/sections.py` (data)

New section builders + kinds. **Every criteria-facing view keys on the stable
criterion ID and uses the description only as a display label** (see the
criteria-identity decision below):
- `failures_first` — one row per NOT-ACHIEVED conversation: persona, scenario,
  violated criteria (keyed by id, shown by description, tagged
  must_happen/must_not_happen from `criteria_meta`), terminated_by, score,
  anchor link to its transcript.
- `persona_scenario_heatmap` — persona × scenario success-rate matrix.
- `criteria_heatmap` — criteria (rows, keyed by id, labelled by description) ×
  conversation (cols), cell = pass/fail; must_not_happen violations flagged for
  hot coloring.
- `score_distribution` — `goal_completion_score` histogram bins.
- `turn_quality_timeline` — average per-turn `response_quality`,
  `hallucination_risk`, `tone_appropriateness`, `factual_accuracy` across turn
  index, from `turn_metrics`.
- `failure_mode` — failed-criteria counts grouped by scenario (replaces treemap).

Enrich the `summary` section data with the fields the hero KPI band + pass/fail
verdict need (success rate, avg score, conversations, errors, total tokens,
verdict).

**Criteria identity (adversarial-review fix).** Raw `rules_broken` IDs
(`criteria_0`) must never reach the page *as content*, but they ARE the stable
key. The current `criteria_results: dict[description, bool]` is lossy:
`Criterion.description` is a free-form, non-unique string, so two criteria with
the same/similar description collide and one silently overwrites the other —
exactly the data corruption this redesign must avoid. Therefore the runner
emits `metadata["criteria_meta"]` as a **list keyed by stable id**:
`[{id, description, type, passed}, ...]`. Section data is keyed by `id`; the
description is joined for display only. The legacy `criteria_results` dict stays
for back-compat; the report prefers `criteria_meta` when present and falls back
to `criteria_results` (neutral coloring, no type) otherwise.

### Layer 3 — `simulation/reports/export_html.py` / `export_md.py`

Register `_SECTION_RENDERERS` entries for the new kinds. HTML renderers use the
new primitives, semantic status classes on ACHIEVED/NOT-ACHIEVED, row sparklines
in persona/scenario tables, and branded chart cards. MD renderers emit the text
equivalents. Section order:

`hero(summary)` → `failures_first` → `persona_scenario_heatmap` →
`criteria_heatmap` → `score_distribution` → `turn_quality_timeline` →
persona/scenario breakdowns → judge verdicts → evaluator scores →
`failure_mode` → token usage → individual conversations.

### Layer 4 — `simulation/runner/simulation.py` (data fixes)

- **Model provenance (adversarial-review fix).** Do **not** populate
  `metadata["model"]` from `SimulationRunner._model` — that is the
  simulator/judge model, not the evaluated target, and a `target_callback` may
  call any provider independently. Filling it from the runner config would print
  a *false* model and mislead readers. Instead: extend the target path so a
  target that knows its identity can supply it (`AgentTarget` may expose
  `model` / return it alongside `(text, usage)`; the orq-deployment adapter
  knows its deployment), surfaced as `metadata["target_model"]`. When the target
  cannot supply it (plain `target_callback`), leave it unset and the report
  **omits the Model row** rather than printing "unknown".
- **`criteria_meta`.** Emit `metadata["criteria_meta"] = [{id, description,
  type, passed}, ...]` (list keyed by stable id, carrying `Criterion.type`).
  Additive in metadata; `SimulationResult` / `criteria_results` contract
  untouched.
- Remove the misleading "full text in report JSON" note. The self-contained HTML
  renders full transcripts in `<details>`; keep an accurate truncation note in
  the Markdown export only.

### Layer 5 — redteam parity (scope-limited)

Redteam is **not** migrated to hand-SVG this round, and its plotly dependency is
**not** dropped. Its charts are mostly its own inline plotly renderers gated on
`charts_available()`; migrating them is a separate effort with its own parity
tests. What redteam DOES inherit, for free, is the shared visual layer: the
consolidated palette and the `report.css` overhaul (cards, semantic colors,
type scale, mobile). Redteam keeps rendering charts via plotly with unchanged
graceful-degrade behaviour.

Constraint: because the existing plotly helpers and `charts_available` /
`try_render_svg` stay in place, the simulation work must be **purely additive**
to `common.reports` — no signature changes or removals on the shared helpers
redteam depends on.

Add a regression test that redteam HTML still renders end-to-end (a) with plotly
present and (b) with plotly absent (degrades to tables) — to prove the additive
changes and the CSS overhaul did not regress it. Migrating redteam charts to
hand-SVG (and only then dropping its plotly need) is a future follow-up.

## Data availability (verified)

- `SimulationResult.criteria_results: dict[str, bool]` — description→passed.
  Usable as a fallback only; lossy on duplicate descriptions (see criteria
  identity). The id-keyed `criteria_meta` is the primary source.
- `SimulationResult.turn_metrics: list[TurnMetrics]` — per-turn quality +
  `judge_reason`. Feeds the turn-quality timeline.
- `metadata["persona"]`, `metadata["scenario"]`, `metadata["model"]`,
  `metadata["evaluator_scores"]` — feed breakdowns and hero.
- `Criterion.type` (`must_happen` / `must_not_happen`) is currently dropped
  before the report; the runner change above re-exposes it via `criteria_meta`.

## Testing

- New section builders: correct data shape and aggregation
  (`tests/simulation/reports/test_sections.py`).
- Hand-SVG primitives: each emits valid non-empty `<svg>`/HTML; `scale_color`
  interpolates endpoints correctly.
- Export smoke (`test_export.py`): HTML + MD render for a multi-result fixture;
  assert **no raw `criteria_0` token leaks** into output; assert hero KPIs and
  failures-first present; assert mobile `@media` block present in CSS.
- Redteam regression: `redteam` HTML export still renders after the additive
  common.reports changes — tested both with plotly installed and with it absent
  (graceful degrade to tables).
- Simulation report asserts it renders identically with plotly absent (it must
  never import plotly).
- All existing tests stay green. Do not remove plotly-availability conditionals
  (redteam still relies on them).

## Risks / mitigations

- **Hand-SVG primitives are new surface area.** Mitigate: keep each primitive
  small, fixed-size, well-tested; reuse a shared `scale_color` + axis helper.
- **Heatmap legibility at scale.** Static SVG can't hover. Mitigate: bake values
  into cells, cap matrix dimensions, and (future) point to the dashboard for
  large runs.
- **Touching shared common.reports could regress redteam.** Mitigate: changes
  are strictly additive (new primitive names, no signature changes/removals on
  the plotly helpers redteam uses); redteam render regression test with plotly
  present AND absent.
- **`criteria_meta` runner change.** Additive in metadata; if absent
  (older results), the report falls back to `criteria_results` with neutral
  coloring and no type — no hard failure. Keyed by stable id to avoid
  description-collision data loss.
- **Model provenance.** Never inferred from runner config; shown only when the
  target supplies it, else the row is omitted. No misleading values.
- **Criterion description collisions.** Section data keyed by id, not
  description; descriptions are display-only labels.

## Out-of-scope follow-ups (note for later)

- Simulation Streamlit dashboard (interactive, plotly.js) — own spec.
- Treemap failure clustering (in the dashboard).
- Trend-over-runs once run history is persisted.
