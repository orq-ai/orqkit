# Simulation Report Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the criteria-heatmap cross-scenario key collision, and persist persona traits + scenario goal/context on `SimulationResult` so the Overview section can show them.

**Architecture:** Two independent concerns. (1) A report-side fix in `sections.py` — namespace each criterion's identity by scenario so positional `criteria_{i}` ids stop colliding across scenarios. (2) A persistence change in the runner — store persona traits and scenario goal/context in result metadata via one shared metadata builder, then enrich the Overview section (HTML + Markdown) to render them with a graceful fallback for older results that lack the fields.

**Tech Stack:** Python 3.10+, Pydantic, pytest, ruff (single quotes, 4-space indent, line-length 120), basedpyright. Package: `packages/evaluatorq-py`. All commands run from that dir with `uv run`.

---

## Background (root causes)

**Heatmap bug.** `_build_criteria_meta` (runner/simulation.py:139) assigns `criterion_id = f'criteria_{i}'` — positional within a scenario. Billing's criterion 0 and API-outage's criterion 0 both get id `criteria_0` despite different descriptions. `_build_criteria_heatmap_section` (sections.py:385) keys rows by bare `id` via `by_id`, which keeps only the *first* description seen for `criteria_0` and then fills that single row with every conversation that has a `criteria_0` — i.e. all of them. Result: rows show PASS/FAIL for criteria a conversation never had. The id is unique *within* a scenario but not across scenarios, so the report must namespace identity by `(scenario, id)`.

**Missing traits/goals.** Result metadata (runner/simulation.py:169-173 and :529-533) stores only `persona.name` and `scenario.name`. The Overview section (sections.py:143) therefore can only list persona names + post-hoc criteria; it cannot show persona traits (patience, assertiveness, …) or scenario goal/context. Those must be persisted at result-construction time.

## File Structure

- Modify: `src/evaluatorq/simulation/reports/sections.py` — heatmap keying (Task 1) + Overview enrichment (Task 3)
- Modify: `src/evaluatorq/simulation/runner/simulation.py` — shared metadata builder persisting traits/goals (Task 2)
- Modify: `src/evaluatorq/simulation/reports/export_html.py` — Overview HTML render of traits/goals (Task 3)
- Modify: `src/evaluatorq/simulation/reports/export_md.py` — Overview Markdown render of traits/goals (Task 3)
- Test: `tests/simulation/reports/test_sections.py` — heatmap + overview builders
- Test: `tests/simulation/reports/test_export.py` — Overview HTML/MD render
- Test: `tests/simulation/runner/` (existing runner test module) — metadata persistence

Run all tests for this work with:
`uv run pytest tests/simulation/reports tests/simulation/runner -q --timeout=90`

---

## Task 1: Namespace criteria-heatmap rows by scenario

**Files:**
- Modify: `src/evaluatorq/simulation/reports/sections.py:385-419` (`_build_criteria_heatmap_section`)
- Test: `tests/simulation/reports/test_sections.py`

Report-side only. No runner change. Key criterion identity by `(scenario_name, id)`; label rows `"{scenario} — {description}"` so scenario-scoped rows are visually distinct. Conversations of other scenarios remain absent (`-1.0`, neutral) for a given row — the existing absent-cell rendering already handles this.

- [ ] **Step 1: Write the failing test**

Add to `tests/simulation/reports/test_sections.py` (uses the existing `make_result` fixture):

```python
def test_criteria_heatmap_does_not_collide_across_scenarios(make_result):
    # Two scenarios, each with a positional criteria_0 of DIFFERENT meaning.
    billing = make_result(
        persona='A', scenario='Billing',
        criteria_meta=[{'id': 'criteria_0', 'description': 'explains charge',
                        'type': 'must_happen', 'passed': True}],
    )
    outage = make_result(
        persona='A', scenario='Outage',
        criteria_meta=[{'id': 'criteria_0', 'description': 'offers next step',
                        'type': 'must_happen', 'passed': False}],
    )
    section = _build_criteria_heatmap_section([billing, outage])
    labels = section.data['y_labels']
    # Both criteria appear as distinct rows (no collapse onto one row).
    assert any('explains charge' in lbl for lbl in labels)
    assert any('offers next step' in lbl for lbl in labels)
    assert len(labels) == 2
    # The billing row has a value only for the billing conversation; the outage
    # conversation is absent (-1.0) on that row.
    rows = {lbl: cells for lbl, cells in zip(section.data['y_labels'], section.data['cells'])}
    billing_row = next(c for lbl, c in rows.items() if 'explains charge' in lbl)
    assert billing_row == [1.0, -1.0]  # billing pass, outage absent
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/simulation/reports/test_sections.py::test_criteria_heatmap_does_not_collide_across_scenarios -v`
Expected: FAIL — current code collapses both criteria onto one row (len(labels) == 1) and fills it for both conversations.

- [ ] **Step 3: Rewrite `_build_criteria_heatmap_section` to key by (scenario, id)**

Replace the body of `_build_criteria_heatmap_section` (sections.py:385-419) with:

```python
def _build_criteria_heatmap_section(results: list[SimulationResult]) -> ReportSection:
    # rows = unique (scenario, criterion id); cols = conversations.
    # Positional ids (criteria_0, ...) are unique only WITHIN a scenario, so the
    # scenario name must be part of the row key to avoid cross-scenario collisions.
    col_labels = [f'#{i + 1}' for i in range(len(results))]
    labels_by_key: dict[tuple[str, str], str] = {}
    order: list[tuple[str, str]] = []
    for r in results:
        scen = _scenario_name(r)
        for c in _criteria_rows(r):
            key = (scen, c['id'])
            if key not in labels_by_key:
                labels_by_key[key] = f'{scen} — {c["description"]}'
                order.append(key)
    cells = []
    safety = []
    for scen, cid in order:
        row_vals, row_safe = [], []
        for r in results:
            match = (
                next((c for c in _criteria_rows(r) if c['id'] == cid), None)
                if _scenario_name(r) == scen
                else None
            )
            if match is None:
                row_vals.append(-1.0)
                row_safe.append(False)
            else:
                row_vals.append(1.0 if match['passed'] else 0.0)
                row_safe.append(match['safety'])
        cells.append(row_vals)
        safety.append(row_safe)
    return ReportSection(
        kind='criteria_heatmap',
        title='Criteria Pass/Fail',
        data={
            'x_labels': col_labels,
            'y_ids': [f'{scen}:{cid}' for scen, cid in order],
            'y_labels': [labels_by_key[k] for k in order],
            'cells': cells,
            'safety': safety,
        },
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/simulation/reports/test_sections.py::test_criteria_heatmap_does_not_collide_across_scenarios -v`
Expected: PASS

- [ ] **Step 5: Check no regression in existing heatmap tests + render**

Run: `uv run pytest tests/simulation/reports -q --timeout=90`
Expected: all pass. (If an existing heatmap test pins old `y_labels`/`y_ids` shape, update it to the scenario-prefixed label — that is the corrected behavior.)

- [ ] **Step 6: Commit**

```bash
git add src/evaluatorq/simulation/reports/sections.py tests/simulation/reports/test_sections.py
git commit -m "fix(evaluatorq-py): namespace criteria-heatmap rows by scenario to stop positional-id collisions (RES-846)"
```

---

## Task 2: Persist persona traits + scenario goal/context in result metadata

**Files:**
- Modify: `src/evaluatorq/simulation/runner/simulation.py:128-188` (add builder, use in `_max_turns_result`)
- Modify: `src/evaluatorq/simulation/runner/simulation.py:529-533` (use builder in judge-termination path)
- Test: `tests/simulation/runner/` (existing runner test file; create `test_metadata.py` if none fits)

Add one shared metadata builder so both result-construction sites stay in sync (DRY). Store traits as a flat dict and goal/context as scalars. Enums serialize to their `.value`. All additive — older results without the keys still work.

- [ ] **Step 1: Write the failing test**

Create `tests/simulation/runner/test_metadata.py`:

```python
from evaluatorq.simulation.runner.simulation import _build_simulation_metadata
from evaluatorq.simulation.types import (
    CommunicationStyle,
    Criterion,
    Persona,
    Scenario,
)


def test_metadata_persists_persona_traits_and_scenario_goal():
    persona = Persona(
        name='Frustrated Customer', patience=0.2, assertiveness=0.8,
        politeness=0.4, technical_level=0.3,
        communication_style=CommunicationStyle.casual, background='Annoyed.',
    )
    scenario = Scenario(
        name='Billing question', goal='Find out why the invoice is higher',
        context='Unexpected charge.',
        criteria=[Criterion(description='explains charge', type='must_happen')],
    )
    meta = _build_simulation_metadata(persona, scenario, criteria_meta=None, target_model='m')
    assert meta['persona'] == 'Frustrated Customer'
    assert meta['scenario'] == 'Billing question'
    assert meta['persona_traits']['patience'] == 0.2
    assert meta['persona_traits']['communication_style'] == 'casual'  # enum -> value
    assert meta['persona_traits']['background'] == 'Annoyed.'
    assert meta['scenario_goal'] == 'Find out why the invoice is higher'
    assert meta['scenario_context'] == 'Unexpected charge.'
    assert meta['target_model'] == 'm'


def test_metadata_handles_missing_persona_and_scenario():
    meta = _build_simulation_metadata(None, None, criteria_meta=None, target_model=None)
    assert meta['persona'] is None
    assert meta['scenario'] is None
    assert 'persona_traits' not in meta
    assert 'scenario_goal' not in meta
    assert 'target_model' not in meta
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/simulation/runner/test_metadata.py -v`
Expected: FAIL with `ImportError` / `AttributeError` — `_build_simulation_metadata` does not exist yet.

- [ ] **Step 3: Add the shared builder**

Insert into `src/evaluatorq/simulation/runner/simulation.py` immediately after `_build_criteria_meta` (after line 154):

```python
def _build_simulation_metadata(
    persona: Persona | None,
    scenario: Scenario | None,
    criteria_meta: list[dict[str, object]] | None,
    target_model: str | None,
) -> dict[str, Any]:
    """Single source of truth for SimulationResult.metadata so every
    construction site persists the same fields. Traits/goal/context are
    additive — absent keys keep older results valid."""
    metadata: dict[str, Any] = {
        'persona': persona.name if persona else None,
        'scenario': scenario.name if scenario else None,
        'criteria_meta': criteria_meta,
    }
    if persona is not None:
        metadata['persona_traits'] = {
            'patience': persona.patience,
            'assertiveness': persona.assertiveness,
            'politeness': persona.politeness,
            'technical_level': persona.technical_level,
            'communication_style': persona.communication_style.value,
            'background': persona.background,
        }
    if scenario is not None:
        metadata['scenario_goal'] = scenario.goal
        metadata['scenario_context'] = scenario.context
    if target_model is not None:
        metadata['target_model'] = target_model
    return metadata
```

Confirm `Persona` and `Scenario` are imported at the top of the file (they are used elsewhere in the runner). If not, add them to the existing `from evaluatorq.simulation.types import ...` block.

- [ ] **Step 4: Use the builder in `_max_turns_result`**

In `_max_turns_result` (sections around line 167-173), replace the inline metadata dict construction:

```python
    criteria_results = _build_criteria_results(scenario, last_judgment) if scenario and last_judgment else None
    criteria_meta = _build_criteria_meta(scenario, last_judgment) if scenario and last_judgment else None
    metadata = _build_simulation_metadata(persona, scenario, criteria_meta, target_model)
```

(Delete the old `metadata: dict[str, Any] = {...}` block and the trailing `if target_model is not None:` append — the builder now owns both.)

- [ ] **Step 5: Use the builder in the judge-termination path**

Replace lines 529-535 (the `judge_metadata = {...}` block plus its `if target_model_holder[...]` append) with:

```python
                judge_metadata = _build_simulation_metadata(
                    persona,
                    scenario,
                    _build_criteria_meta(scenario, last_judgment) if scenario else None,
                    target_model_holder['model'],
                )
```

- [ ] **Step 6: Run the metadata test + full runner suite**

Run: `uv run pytest tests/simulation/runner/test_metadata.py tests/simulation/runner -q --timeout=90`
Expected: PASS. No existing runner test should break (the change is additive).

- [ ] **Step 7: Lint + typecheck**

Run: `uv run ruff check src/evaluatorq/simulation/runner/simulation.py && uv run basedpyright src/evaluatorq/simulation/runner/simulation.py`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/evaluatorq/simulation/runner/simulation.py tests/simulation/runner/test_metadata.py
git commit -m "feat(evaluatorq-py): persist persona traits and scenario goal/context in simulation metadata (RES-846)"
```

---

## Task 3: Render persona traits + scenario goals in the Overview section

**Files:**
- Modify: `src/evaluatorq/simulation/reports/sections.py:143-168` (`_build_overview_section`)
- Modify: `src/evaluatorq/simulation/reports/export_html.py` (`_render_overview_html`)
- Modify: `src/evaluatorq/simulation/reports/export_md.py` (`_render_overview_section`)
- Test: `tests/simulation/reports/test_sections.py`, `tests/simulation/reports/test_export.py`

Pull traits/goal/context from metadata when present; fall back to today's name-only behavior when absent (older results). Show one representative trait set per persona name (traits are constant per persona).

- [ ] **Step 1: Write the failing builder test**

Add to `tests/simulation/reports/test_sections.py`. The `make_result` fixture doesn't pass arbitrary metadata, so build the result inline:

```python
def test_overview_section_includes_traits_and_goal_when_present():
    from evaluatorq.simulation.types import SimulationResult, TerminatedBy, TokenUsage

    r = SimulationResult(
        messages=[], terminated_by=TerminatedBy.judge, reason='r',
        goal_achieved=True, goal_completion_score=1.0, rules_broken=[],
        turn_count=1, turn_metrics=[],
        token_usage=TokenUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        metadata={
            'persona': 'Frustrated Customer', 'scenario': 'Billing',
            'persona_traits': {'patience': 0.2, 'assertiveness': 0.8,
                               'politeness': 0.4, 'technical_level': 0.3,
                               'communication_style': 'casual', 'background': 'Annoyed.'},
            'scenario_goal': 'Explain the invoice', 'scenario_context': 'Unexpected charge.',
            'criteria_meta': [{'id': 'criteria_0', 'description': 'explains charge',
                               'type': 'must_happen', 'passed': True}],
        },
    )
    section = _build_overview_section([r])
    persona = section.data['personas'][0]
    assert persona['traits']['patience'] == 0.2
    assert persona['background'] == 'Annoyed.'
    scenario = section.data['scenarios'][0]
    assert scenario['goal'] == 'Explain the invoice'
    assert scenario['context'] == 'Unexpected charge.'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/simulation/reports/test_sections.py::test_overview_section_includes_traits_and_goal_when_present -v`
Expected: FAIL with `KeyError: 'traits'` — builder doesn't surface traits yet.

- [ ] **Step 3: Enrich `_build_overview_section`**

Replace `_build_overview_section` (sections.py:143-168) with:

```python
def _build_overview_section(results: list[SimulationResult]) -> ReportSection:
    """Introductory framing: which personas (with traits) and scenarios (with
    goals + criteria) were exercised. Traits/goals are read from metadata when
    persisted; older results fall back to names + recovered criteria only."""
    personas: dict[str, dict[str, Any]] = {}
    for r in results:
        name = _persona_name(r)
        if name not in personas:
            traits = r.metadata.get('persona_traits')
            personas[name] = {
                'name': name,
                'conversations': 0,
                'traits': traits if isinstance(traits, dict) else None,
                'background': (traits or {}).get('background') if isinstance(traits, dict) else None,
            }
        personas[name]['conversations'] += 1

    scenarios: dict[str, dict[str, Any]] = {}
    for r in results:
        name = _scenario_name(r)
        if name not in scenarios:
            scenarios[name] = {
                'name': name,
                'goal': r.metadata.get('scenario_goal'),
                'context': r.metadata.get('scenario_context'),
                'criteria': [{'description': c['description'], 'type': c['type']} for c in _criteria_rows(r)],
            }

    return ReportSection(
        kind='overview',
        title='Overview',
        data={
            'total_conversations': len(results),
            'personas': list(personas.values()),
            'scenarios': list(scenarios.values()),
        },
    )
```

- [ ] **Step 4: Run builder test to verify it passes**

Run: `uv run pytest tests/simulation/reports/test_sections.py::test_overview_section_includes_traits_and_goal_when_present -v`
Expected: PASS

- [ ] **Step 5: Write failing render test (HTML + MD)**

Add to `tests/simulation/reports/test_export.py` (reuse whatever result-builder the existing export tests use; build inline with the same metadata as Step 1):

```python
def test_overview_html_and_md_show_traits_and_goal():
    from evaluatorq.simulation.reports import export_html, export_markdown
    from evaluatorq.simulation.types import SimulationResult, TerminatedBy, TokenUsage

    r = SimulationResult(
        messages=[], terminated_by=TerminatedBy.judge, reason='r',
        goal_achieved=True, goal_completion_score=1.0, rules_broken=[],
        turn_count=1, turn_metrics=[],
        token_usage=TokenUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        metadata={
            'persona': 'Frustrated Customer', 'scenario': 'Billing',
            'persona_traits': {'patience': 0.2, 'assertiveness': 0.8, 'politeness': 0.4,
                               'technical_level': 0.3, 'communication_style': 'casual',
                               'background': 'Annoyed.'},
            'scenario_goal': 'Explain the invoice', 'scenario_context': 'Unexpected charge.',
            'criteria_meta': [{'id': 'criteria_0', 'description': 'explains charge',
                               'type': 'must_happen', 'passed': True}],
        },
    )
    html = export_html([r], target='Agent')
    md = export_markdown([r], target='Agent')
    assert 'Explain the invoice' in html and 'Explain the invoice' in md
    assert 'Annoyed.' in html and 'Annoyed.' in md
```

- [ ] **Step 6: Run render test to verify it fails**

Run: `uv run pytest tests/simulation/reports/test_export.py::test_overview_html_and_md_show_traits_and_goal -v`
Expected: FAIL — renderers don't emit goal/background yet.

- [ ] **Step 7: Update `_render_overview_html`**

In `src/evaluatorq/simulation/reports/export_html.py`, find `_render_overview_html`. For each persona, when `p.get('traits')` is present, render a compact trait line (e.g. `patience 0.2 · assertiveness 0.8 · politeness 0.4 · technical 0.3 · casual`) and the `background` beneath the name; when absent, render the name only (today's behavior). For each scenario, render `goal` (and `context` if present) above the criteria tags; guard each with a truthiness check so `None` renders nothing. Escape all interpolated strings with the module's existing `esc(...)` helper and keep markup consistent with the existing `.intro-list` / `.crit-tag` classes (add a `.intro-meta` span styled in `report.css` if a distinct trait line style is wanted — optional).

- [ ] **Step 8: Update `_render_overview_section` (Markdown)**

In `src/evaluatorq/simulation/reports/export_md.py`, mirror the HTML: under each persona bullet add an indented trait line + background when present; under each scenario add a `**Goal:** …` line (and `**Context:** …` if present) before the criteria list. Guard `None` values.

- [ ] **Step 9: Run render test to verify it passes**

Run: `uv run pytest tests/simulation/reports/test_export.py::test_overview_html_and_md_show_traits_and_goal -v`
Expected: PASS

- [ ] **Step 10: Full report suite + lint + typecheck**

Run: `uv run pytest tests/simulation/reports -q --timeout=90`
Then: `uv run ruff check src/evaluatorq/simulation/reports/sections.py src/evaluatorq/simulation/reports/export_html.py src/evaluatorq/simulation/reports/export_md.py && uv run basedpyright src/evaluatorq/simulation/reports/sections.py src/evaluatorq/simulation/reports/export_html.py src/evaluatorq/simulation/reports/export_md.py`
Expected: all tests pass; no new lint/type errors.

- [ ] **Step 11: Regenerate the demo report and eyeball it**

Delete the stale cache so traits/goals get persisted on a fresh run (old cached results predate Task 2 and lack the new metadata):

```bash
rm -f /tmp/sim_results_large.json
uv run python /tmp/sim_report_large.py
```

Open `scripts/manual_tests/report.html` and confirm the Overview shows persona traits + scenario goals, and the criteria heatmap rows are scenario-scoped with no cross-scenario PASS/FAIL bleed.

- [ ] **Step 12: Commit**

```bash
git add src/evaluatorq/simulation/reports/sections.py src/evaluatorq/simulation/reports/export_html.py src/evaluatorq/simulation/reports/export_md.py tests/simulation/reports/test_sections.py tests/simulation/reports/test_export.py
git commit -m "feat(evaluatorq-py): render persona traits and scenario goals in report overview (RES-846)"
```

---

## Notes / decisions locked

- **Heatmap fix is report-side only.** We do *not* change the runner's positional `criteria_{i}` ids, because the judge's `rules_broken` membership test depends on that exact format. Namespacing happens in the report where scenario context is available.
- **Metadata change is additive.** New keys (`persona_traits`, `scenario_goal`, `scenario_context`) are optional; the Overview falls back to name-only for results that predate this change. No migration needed.
- **One shared metadata builder** (`_build_simulation_metadata`) prevents the two construction sites from drifting again — this is the root reason traits were never persisted at one site.
- **Cached demo results are stale** for Task 2/3 — they must be regenerated (Step 11) or the Overview will show name-only fallback even after the code lands.
