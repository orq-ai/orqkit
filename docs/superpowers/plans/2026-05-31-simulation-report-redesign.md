# Simulation Report Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the agent-simulation static report into a designed, failure-first artifact with hand-authored SVG/CSS charts (hero scorecard, heatmaps, score distribution, turn-quality timeline, failure-mode bar), fixing the `criteria_0` / `Model: unknown` bugs, with shared work in `common.reports` and zero new dependencies.

**Architecture:** Keep the existing layered pipeline (`sections.py` builds renderer-agnostic `ReportSection(kind, data)`; HTML/MD renderers dispatch by `kind`). Add new hand-SVG/CSS chart primitives to `common.reports` under **new names** (additive — existing plotly helpers stay for redteam). Simulation report imports no plotly. Runner emits id-keyed `criteria_meta` and target-supplied `target_model`.

**Tech Stack:** Python 3.10+, pydantic, pytest, hand-authored SVG/HTML/CSS string builders. Package manager `uv`. Run from `packages/evaluatorq-py/`.

**Spec:** `docs/superpowers/specs/2026-05-31-simulation-report-redesign-design.md`

**Conventions:**
- All commands run from `packages/evaluatorq-py/`.
- Test: `uv run pytest -m 'not integration'`. Lint: `uv run ruff check src`. Types: `uv run basedpyright`.
- Tab indentation, single quotes (ruff format), `from __future__ import annotations`.
- Commit after each task. Keep commits scoped.

---

## File Structure

**Shared (`src/evaluatorq/common/reports/`):**
- `palette.py` — **new.** Consolidated brand palette (moved from `redteam/ui/colors.py`).
- `html_helpers.py` — **modify.** Add hand-SVG/CSS primitives: `scale_color`, `svg_donut`, `svg_bar`, `render_heatmap`, `render_histogram`, `render_line_chart`, `render_sparkline`, `kpi_cards`, `status_badge`. Leave existing plotly helpers untouched.
- `md_helpers.py` — **modify.** Add `md_heatmap`, `md_badge`, `md_distribution`.
- `__init__.py` — **modify.** Export new helpers + palette.
- `report.css` — **modify.** Hero, cards, semantic status, heatmap, sparkline, type scale, mobile.

**Redteam (`src/evaluatorq/redteam/ui/`):**
- `colors.py` — **modify.** Re-export from `common.reports.palette` (back-compat shim).

**Simulation (`src/evaluatorq/simulation/`):**
- `runner/simulation.py` — **modify.** `_build_criteria_meta`, set `metadata["criteria_meta"]` + `metadata["target_model"]`.
- `reports/sections.py` — **modify.** New section builders + new kinds, enriched summary.
- `reports/export_html.py` — **modify.** New renderers, hero + card layout, semantic colors, sparklines.
- `reports/export_md.py` — **modify.** New renderers (text equivalents).

**Tests (`tests/`):**
- `common/reports/test_html_helpers.py` — **new.**
- `common/reports/test_palette.py` — **new.**
- `simulation/reports/test_sections.py` — **modify.** New section builder tests.
- `simulation/reports/test_export.py` — **modify.** New assertions (no `criteria_0` leak, hero present, no-plotly render).
- `redteam/reports/test_export_regression.py` — **new.** redteam renders with/without plotly.

---

## Phase 0 — Palette consolidation

### Task 0.1: Move brand palette into `common.reports.palette`

**Files:**
- Create: `src/evaluatorq/common/reports/palette.py`
- Test: `tests/common/reports/test_palette.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/common/reports/test_palette.py
from evaluatorq.common.reports import palette


def test_palette_exports_core_and_semantic():
    assert palette.COLORS["orange_300"] == "#ff8f34"
    assert palette.SEVERITY_COLORS["critical"] == palette.COLORS["red_400"]
    assert palette.SEVERITY_ORDER == ["critical", "high", "medium", "low"]
    assert len(palette.QUALITATIVE) >= 6
    # heat scale endpoints
    assert palette.ORQ_SCALE_GOOD_BAD[0][1] == palette.COLORS["success_400"]
    assert palette.ORQ_SCALE_GOOD_BAD[-1][1] == palette.COLORS["red_400"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/common/reports/test_palette.py -v`
Expected: FAIL with `ModuleNotFoundError: ... palette`.

- [ ] **Step 3: Create the palette module**

Copy the full contents of `src/evaluatorq/redteam/ui/colors.py` into the new file `src/evaluatorq/common/reports/palette.py` (the `COLORS`, `SEVERITY_COLORS`, `SEVERITY_ORDER`, `STATUS_COLORS`, `ORQ_SCALE_HEAT`, `ORQ_SCALE_GOOD_BAD`, `ORQ_SCALE_AGENT`, `QUALITATIVE` definitions). Update the module docstring to say it is the canonical shared palette. Note: `common.reports` already defines `COLORS` / `STATUS_COLORS` in `html_helpers.py` — keep `palette.py` as the superset and have `html_helpers` import from it (Step 5).

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/common/reports/test_palette.py -v`
Expected: PASS.

- [ ] **Step 5: Point existing `common` color refs at palette**

In `src/evaluatorq/common/reports/html_helpers.py`, replace the local `COLORS` / `STATUS_COLORS` definitions with `from evaluatorq.common.reports.palette import COLORS, STATUS_COLORS` (re-export so existing `from ...html_helpers import COLORS` keeps working). In `src/evaluatorq/common/reports/__init__.py`, add `from evaluatorq.common.reports.palette import (COLORS, STATUS_COLORS, SEVERITY_COLORS, SEVERITY_ORDER, QUALITATIVE, ORQ_SCALE_HEAT, ORQ_SCALE_GOOD_BAD, ORQ_SCALE_AGENT)` and add those names to `__all__`.

- [ ] **Step 6: Run full report tests to confirm no regression**

Run: `uv run pytest tests/ -m 'not integration' -k 'report or palette or redteam' -q`
Expected: PASS (existing tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/evaluatorq/common/reports/palette.py src/evaluatorq/common/reports/html_helpers.py src/evaluatorq/common/reports/__init__.py tests/common/reports/test_palette.py
git commit -m "refactor(evaluatorq-py): consolidate brand palette into common.reports.palette (RES-846)"
```

### Task 0.2: Make `redteam/ui/colors.py` a back-compat shim

**Files:**
- Modify: `src/evaluatorq/redteam/ui/colors.py`

- [ ] **Step 1: Replace body with re-export**

Replace the contents of `src/evaluatorq/redteam/ui/colors.py` with:

```python
"""Back-compat shim. Canonical palette now lives in common.reports.palette."""

from __future__ import annotations

from evaluatorq.common.reports.palette import (  # noqa: F401
    COLORS,
    ORQ_SCALE_AGENT,
    ORQ_SCALE_GOOD_BAD,
    ORQ_SCALE_HEAT,
    QUALITATIVE,
    SEVERITY_COLORS,
    SEVERITY_ORDER,
    STATUS_COLORS,
)
```

- [ ] **Step 2: Verify redteam dashboard import still resolves**

Run: `uv run python -c "from evaluatorq.redteam.ui.colors import COLORS, SEVERITY_COLORS, ORQ_SCALE_HEAT; print('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Run redteam tests**

Run: `uv run pytest tests/redteam -m 'not integration' -q`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/evaluatorq/redteam/ui/colors.py
git commit -m "refactor(evaluatorq-py): redteam colors re-export from common palette (RES-846)"
```

---

## Phase 1 — Shared hand-SVG/CSS primitives

All primitives are pure string builders. No plotly import anywhere in this phase.

### Task 1.1: `scale_color` — interpolate a brand color scale

**Files:**
- Modify: `src/evaluatorq/common/reports/html_helpers.py`
- Test: `tests/common/reports/test_html_helpers.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/common/reports/test_html_helpers.py
from evaluatorq.common.reports import html_helpers as h
from evaluatorq.common.reports.palette import ORQ_SCALE_GOOD_BAD


def test_scale_color_endpoints_and_clamp():
    assert h.scale_color(0.0, ORQ_SCALE_GOOD_BAD).lower() == "#2ebd85"
    assert h.scale_color(1.0, ORQ_SCALE_GOOD_BAD).lower() == "#d92d20"
    # clamps out-of-range
    assert h.scale_color(-5, ORQ_SCALE_GOOD_BAD).lower() == "#2ebd85"
    assert h.scale_color(9, ORQ_SCALE_GOOD_BAD).lower() == "#d92d20"


def test_scale_color_midpoint_is_between():
    mid = h.scale_color(0.5, ORQ_SCALE_GOOD_BAD).lstrip("#")
    r = int(mid[0:2], 16)
    # midpoint is the yellow stop (#f2b600) -> red channel high
    assert r > 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/common/reports/test_html_helpers.py::test_scale_color_endpoints_and_clamp -v`
Expected: FAIL (`AttributeError: scale_color`).

- [ ] **Step 3: Implement `scale_color`**

Add to `html_helpers.py`:

```python
def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*(max(0, min(255, int(round(c)))) for c in rgb))


def scale_color(value: float, scale: list[list[float | str]]) -> str:
    """Interpolate a hex color for ``value`` in [0, 1] along a Plotly-style scale.

    ``scale`` is a list of ``[position, hex]`` stops sorted by position.
    Values outside [0, 1] are clamped to the scale endpoints.
    """
    v = max(0.0, min(1.0, float(value)))
    stops = [(float(pos), str(color)) for pos, color in scale]
    for i in range(len(stops) - 1):
        lo_pos, lo_color = stops[i]
        hi_pos, hi_color = stops[i + 1]
        if lo_pos <= v <= hi_pos:
            span = hi_pos - lo_pos or 1.0
            t = (v - lo_pos) / span
            lo = _hex_to_rgb(lo_color)
            hi = _hex_to_rgb(hi_color)
            return _rgb_to_hex(tuple(lo[c] + (hi[c] - lo[c]) * t for c in range(3)))
    return stops[-1][1]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -v`
Expected: PASS (both scale_color tests).

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/common/reports/html_helpers.py tests/common/reports/test_html_helpers.py
git commit -m "feat(evaluatorq-py): add scale_color helper to common.reports (RES-846)"
```

### Task 1.2: `svg_donut` — hand-SVG donut with center label

**Files:**
- Modify: `src/evaluatorq/common/reports/html_helpers.py`
- Test: `tests/common/reports/test_html_helpers.py`

- [ ] **Step 1: Write the failing test**

```python
def test_svg_donut_renders_slices_and_center():
    svg = h.svg_donut(
        labels=["Achieved", "Failed"],
        values=[1, 3],
        colors=["#2ebd85", "#d92d20"],
        center_label="25%",
        title="Goal Outcomes",
    )
    assert svg.startswith("<figure")
    assert "<svg" in svg and "</svg>" in svg
    assert svg.count("<path") == 2  # one arc per non-zero slice
    assert "25%" in svg
    assert "Goal Outcomes" in svg


def test_svg_donut_empty_when_all_zero():
    assert h.svg_donut(labels=["a"], values=[0], colors=["#000"], center_label="", title="t") == ""
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k svg_donut -v`
Expected: FAIL (`AttributeError: svg_donut`).

- [ ] **Step 3: Implement `svg_donut`**

```python
import math


def _arc_path(cx: float, cy: float, r_outer: float, r_inner: float, a0: float, a1: float) -> str:
    """SVG path for a donut segment between angles a0..a1 (radians, 0 = top, clockwise)."""
    def pt(r: float, a: float) -> tuple[float, float]:
        return cx + r * math.sin(a), cy - r * math.cos(a)
    large = 1 if (a1 - a0) > math.pi else 0
    x0o, y0o = pt(r_outer, a0)
    x1o, y1o = pt(r_outer, a1)
    x1i, y1i = pt(r_inner, a1)
    x0i, y0i = pt(r_inner, a0)
    return (
        f"M{x0o:.2f},{y0o:.2f} "
        f"A{r_outer:.2f},{r_outer:.2f} 0 {large} 1 {x1o:.2f},{y1o:.2f} "
        f"L{x1i:.2f},{y1i:.2f} "
        f"A{r_inner:.2f},{r_inner:.2f} 0 {large} 0 {x0i:.2f},{y0i:.2f} Z"
    )


def svg_donut(
    *,
    labels: list[str],
    values: list[float],
    colors: list[str],
    center_label: str,
    title: str,
    size: int = 220,
) -> str:
    """Hand-authored SVG donut. Returns '' when all values are zero."""
    total = sum(v for v in values if v > 0)
    if total <= 0:
        return ""
    cx = cy = size / 2
    r_outer = size / 2 - 4
    r_inner = r_outer * 0.62
    parts: list[str] = [f'<svg viewBox="0 0 {size} {size}" role="img" aria-label="{esc(title)}">']
    angle = 0.0
    for label, value, color in zip(labels, values, colors, strict=False):
        if value <= 0:
            continue
        frac = value / total
        a1 = angle + frac * 2 * math.pi
        parts.append(
            f'<path d="{_arc_path(cx, cy, r_outer, r_inner, angle, a1)}" '
            f'fill="{color}"><title>{esc(label)}: {value:g}</title></path>'
        )
        angle = a1
    parts.append(
        f'<text x="{cx}" y="{cy}" text-anchor="middle" dominant-baseline="central" '
        f'class="donut-center">{esc(center_label)}</text>'
    )
    parts.append("</svg>")
    return f'<figure class="chart-card"><figcaption>{esc(title)}</figcaption>{"".join(parts)}</figure>'
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k svg_donut -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/common/reports/html_helpers.py tests/common/reports/test_html_helpers.py
git commit -m "feat(evaluatorq-py): hand-SVG donut chart primitive (RES-846)"
```

### Task 1.3: `svg_bar` — horizontal bar chart with value labels

**Files:**
- Modify: `src/evaluatorq/common/reports/html_helpers.py`
- Test: `tests/common/reports/test_html_helpers.py`

- [ ] **Step 1: Write the failing test**

```python
def test_svg_bar_renders_labeled_bars():
    svg = h.svg_bar(
        rows=[("1 turn", 3), ("2 turns", 1)],
        title="Conversations by turn count",
    )
    assert svg.startswith("<figure")
    assert svg.count("<rect") == 2
    assert "1 turn" in svg and "3" in svg
    assert "Conversations by turn count" in svg


def test_svg_bar_empty_when_no_rows():
    assert h.svg_bar(rows=[], title="t") == ""
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k svg_bar -v`
Expected: FAIL.

- [ ] **Step 3: Implement `svg_bar`**

```python
def svg_bar(
    *,
    rows: list[tuple[str, float]],
    title: str,
    color: str | None = None,
    width: int = 420,
    bar_height: int = 22,
    gap: int = 10,
) -> str:
    """Horizontal bar chart as hand-authored SVG. Returns '' when no rows."""
    if not rows:
        return ""
    from evaluatorq.common.reports.palette import COLORS
    bar_color = color or COLORS["teal_400"]
    label_w = 130
    max_val = max((v for _, v in rows), default=0) or 1
    plot_w = width - label_w - 48
    height = len(rows) * (bar_height + gap) + gap
    parts = [f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{esc(title)}">']
    y = gap
    for label, value in rows:
        bar_w = (value / max_val) * plot_w
        parts.append(
            f'<text x="{label_w - 8}" y="{y + bar_height / 2}" text-anchor="end" '
            f'dominant-baseline="central" class="bar-label">{esc(label)}</text>'
        )
        parts.append(
            f'<rect x="{label_w}" y="{y}" width="{bar_w:.1f}" height="{bar_height}" '
            f'rx="3" fill="{bar_color}"></rect>'
        )
        parts.append(
            f'<text x="{label_w + bar_w + 6:.1f}" y="{y + bar_height / 2}" '
            f'dominant-baseline="central" class="bar-value">{value:g}</text>'
        )
        y += bar_height + gap
    parts.append("</svg>")
    return f'<figure class="chart-card"><figcaption>{esc(title)}</figcaption>{"".join(parts)}</figure>'
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k svg_bar -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/common/reports/html_helpers.py tests/common/reports/test_html_helpers.py
git commit -m "feat(evaluatorq-py): hand-SVG horizontal bar primitive (RES-846)"
```

### Task 1.4: `render_heatmap` — colored-cell HTML table

Mirrors redteam's `_render_attack_heatmap_html` (`redteam/reports/export_html.py:635`): an HTML table of colored `<td>` cells.

**Files:**
- Modify: `src/evaluatorq/common/reports/html_helpers.py`
- Test: `tests/common/reports/test_html_helpers.py`

- [ ] **Step 1: Write the failing test**

```python
from evaluatorq.common.reports.palette import ORQ_SCALE_GOOD_BAD


def test_render_heatmap_cells_and_labels():
    html = h.render_heatmap(
        x_labels=["c1", "c2"],
        y_labels=["must explain charge", "must not be rude"],
        cells=[[1.0, 0.0], [1.0, 1.0]],  # row-major: y by x
        scale=ORQ_SCALE_GOOD_BAD,
        title="Criteria pass/fail",
        value_fmt=lambda v: "PASS" if v >= 0.5 else "FAIL",
    )
    assert 'class="heatmap-table"' in html
    assert html.count("<td") >= 4
    assert "must explain charge" in html
    assert "PASS" in html and "FAIL" in html
    assert "Criteria pass/fail" in html


def test_render_heatmap_safety_flag_uses_hot_class():
    html = h.render_heatmap(
        x_labels=["c1"], y_labels=["no PII leak"], cells=[[0.0]],
        scale=ORQ_SCALE_GOOD_BAD, title="t",
        value_fmt=lambda v: "FAIL", safety_mask=[[True]],
    )
    assert "heatmap-cell--safety" in html
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k heatmap -v`
Expected: FAIL.

- [ ] **Step 3: Implement `render_heatmap`**

```python
from collections.abc import Callable, Sequence


def render_heatmap(
    *,
    x_labels: Sequence[str],
    y_labels: Sequence[str],
    cells: Sequence[Sequence[float]],
    scale: list[list[float | str]],
    title: str,
    value_fmt: Callable[[float], str] = lambda v: f"{v:.0%}",
    safety_mask: Sequence[Sequence[bool]] | None = None,
) -> str:
    """Heatmap as an HTML table of color-filled cells.

    ``cells[y][x]`` holds the value in [0, 1] for row ``y_labels[y]`` and
    column ``x_labels[x]``. ``safety_mask[y][x]`` marks a cell as a safety
    violation (rendered with the ``heatmap-cell--safety`` modifier).
    """
    if not x_labels or not y_labels:
        return ""
    head = "".join(f"<th>{esc(x)}</th>" for x in x_labels)
    body_rows: list[str] = []
    for yi, ylabel in enumerate(y_labels):
        tds = [f"<td class='heatmap-row-label'><strong>{esc(ylabel)}</strong></td>"]
        for xi in range(len(x_labels)):
            value = float(cells[yi][xi])
            color = scale_color(value, scale)
            is_safety = bool(safety_mask and safety_mask[yi][xi])
            cls = "heatmap-cell heatmap-cell--safety" if is_safety else "heatmap-cell"
            tds.append(
                f"<td><span class='{cls}' style='background:{color}'>"
                f"{esc(value_fmt(value))}</span></td>"
            )
        body_rows.append("<tr>" + "".join(tds) + "</tr>")
    return (
        f"<figure class='chart-card'><figcaption>{esc(title)}</figcaption>"
        f"<div style='overflow-x:auto'><table class='heatmap-table'>"
        f"<thead><tr><th></th>{head}</tr></thead>"
        f"<tbody>{''.join(body_rows)}</tbody></table></div></figure>"
    )
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k heatmap -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/common/reports/html_helpers.py tests/common/reports/test_html_helpers.py
git commit -m "feat(evaluatorq-py): hand-HTML heatmap primitive (RES-846)"
```

### Task 1.5: `render_histogram`, `render_line_chart`, `render_sparkline`

**Files:**
- Modify: `src/evaluatorq/common/reports/html_helpers.py`
- Test: `tests/common/reports/test_html_helpers.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_render_histogram_bins():
    html = h.render_histogram(values=[0.0, 0.1, 0.9, 1.0], bins=2, title="Score distribution")
    assert html.startswith("<figure")
    assert html.count("<rect") == 2
    assert "Score distribution" in html


def test_render_line_chart_series():
    html = h.render_line_chart(
        x_labels=["1", "2", "3"],
        series=[("response_quality", [0.5, 0.7, 0.9])],
        title="Turn quality",
    )
    assert html.startswith("<figure")
    assert "<polyline" in html
    assert "response_quality" in html
    assert "Turn quality" in html


def test_render_sparkline_minibars():
    svg = h.render_sparkline([1, 3, 2])
    assert svg.startswith("<svg") and svg.endswith("</svg>")
    assert svg.count("<rect") == 3


def test_render_sparkline_empty():
    assert h.render_sparkline([]) == ""
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k "histogram or line_chart or sparkline" -v`
Expected: FAIL.

- [ ] **Step 3: Implement the three primitives**

```python
def render_histogram(*, values: list[float], bins: int, title: str, width: int = 420, height: int = 180) -> str:
    """Histogram of values in [0, 1] as hand-authored SVG. Returns '' when empty."""
    if not values or bins <= 0:
        return ""
    from evaluatorq.common.reports.palette import COLORS
    counts = [0] * bins
    for v in values:
        idx = min(bins - 1, max(0, int(float(v) * bins)))
        counts[idx] += 1
    max_count = max(counts) or 1
    pad = 28
    plot_w = width - pad * 2
    plot_h = height - pad * 2
    bar_w = plot_w / bins
    parts = [f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{esc(title)}">']
    for i, c in enumerate(counts):
        bar_h = (c / max_count) * plot_h
        x = pad + i * bar_w
        y = pad + (plot_h - bar_h)
        parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w - 3:.1f}" height="{bar_h:.1f}" '
            f'rx="2" fill="{COLORS["teal_400"]}"><title>{i / bins:.1f}-{(i + 1) / bins:.1f}: {c}</title></rect>'
        )
        if c:
            parts.append(
                f'<text x="{x + bar_w / 2:.1f}" y="{y - 4:.1f}" text-anchor="middle" '
                f'class="bar-value">{c}</text>'
            )
    parts.append("</svg>")
    return f'<figure class="chart-card"><figcaption>{esc(title)}</figcaption>{"".join(parts)}</figure>'


def render_line_chart(
    *, x_labels: list[str], series: list[tuple[str, list[float]]], title: str,
    width: int = 460, height: int = 220,
) -> str:
    """Multi-series line chart (values in [0, 1]) as hand-authored SVG."""
    if not x_labels or not series:
        return ""
    from evaluatorq.common.reports.palette import QUALITATIVE
    pad = 32
    plot_w = width - pad * 2
    plot_h = height - pad * 2
    n = max(1, len(x_labels) - 1)
    def x_at(i: int) -> float:
        return pad + (i / n) * plot_w
    def y_at(v: float) -> float:
        return pad + (1 - max(0.0, min(1.0, v))) * plot_h
    parts = [f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{esc(title)}">']
    # axes
    parts.append(f'<line x1="{pad}" y1="{pad}" x2="{pad}" y2="{pad + plot_h}" class="axis"/>')
    parts.append(f'<line x1="{pad}" y1="{pad + plot_h}" x2="{pad + plot_w}" y2="{pad + plot_h}" class="axis"/>')
    legend = []
    for si, (name, ys) in enumerate(series):
        color = QUALITATIVE[si % len(QUALITATIVE)]
        pts = " ".join(f"{x_at(i):.1f},{y_at(v):.1f}" for i, v in enumerate(ys))
        parts.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2"/>')
        legend.append(
            f'<span class="legend-item"><span class="legend-swatch" style="background:{color}"></span>'
            f'{esc(name)}</span>'
        )
    parts.append("</svg>")
    return (
        f'<figure class="chart-card"><figcaption>{esc(title)}</figcaption>'
        f'{"".join(parts)}<div class="legend">{"".join(legend)}</div></figure>'
    )


def render_sparkline(values: list[float], *, width: int = 80, height: int = 20) -> str:
    """Tiny inline mini-bar SVG for table rows. Returns '' when empty."""
    if not values:
        return ""
    from evaluatorq.common.reports.palette import COLORS
    max_val = max(values) or 1
    bar_w = width / len(values)
    parts = [f'<svg class="sparkline" viewBox="0 0 {width} {height}" preserveAspectRatio="none">']
    for i, v in enumerate(values):
        bar_h = (v / max_val) * height
        parts.append(
            f'<rect x="{i * bar_w:.1f}" y="{height - bar_h:.1f}" '
            f'width="{bar_w - 1:.1f}" height="{bar_h:.1f}" fill="{COLORS["teal_400"]}"/>'
        )
    parts.append("</svg>")
    return "".join(parts)
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k "histogram or line_chart or sparkline" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/common/reports/html_helpers.py tests/common/reports/test_html_helpers.py
git commit -m "feat(evaluatorq-py): histogram, line, sparkline primitives (RES-846)"
```

### Task 1.6: `kpi_cards` and `status_badge`

**Files:**
- Modify: `src/evaluatorq/common/reports/html_helpers.py`
- Test: `tests/common/reports/test_html_helpers.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_kpi_cards_renders_each_card_with_status():
    html = h.kpi_cards([
        {"label": "Success Rate", "value": "25%", "status": "fail"},
        {"label": "Conversations", "value": "4", "status": "neutral"},
    ])
    assert 'class="kpi-band"' in html
    assert html.count("kpi-card") >= 2
    assert "Success Rate" in html and "25%" in html
    assert "kpi-card--fail" in html


def test_status_badge_classes():
    assert "status-badge--pass" in h.status_badge("ACHIEVED", "pass")
    assert "status-badge--fail" in h.status_badge("NOT ACHIEVED", "fail")
    assert "NOT ACHIEVED" in h.status_badge("NOT ACHIEVED", "fail")
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k "kpi or badge" -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

```python
def status_badge(text: str, status: str) -> str:
    """Semantic pill. ``status`` in {pass, fail, warn, neutral}."""
    safe_status = status if status in {"pass", "fail", "warn", "neutral"} else "neutral"
    return f'<span class="status-badge status-badge--{safe_status}">{esc(text)}</span>'


def kpi_cards(cards: list[dict[str, str]]) -> str:
    """Render a KPI scorecard band. Each card: {label, value, status?}."""
    if not cards:
        return ""
    items = []
    for c in cards:
        status = c.get("status", "neutral")
        safe_status = status if status in {"pass", "fail", "warn", "neutral"} else "neutral"
        items.append(
            f'<div class="kpi-card kpi-card--{safe_status}">'
            f'<div class="kpi-value">{esc(c["value"])}</div>'
            f'<div class="kpi-label">{esc(c["label"])}</div></div>'
        )
    return f'<div class="kpi-band">{"".join(items)}</div>'
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -k "kpi or badge" -v`
Expected: PASS.

- [ ] **Step 5: Export new helpers from `__init__.py`**

In `src/evaluatorq/common/reports/__init__.py`, add to the `html_helpers` import block and `__all__`: `scale_color, svg_donut, svg_bar, render_heatmap, render_histogram, render_line_chart, render_sparkline, kpi_cards, status_badge`.

- [ ] **Step 6: Run full helper suite + import check**

Run: `uv run pytest tests/common/reports/test_html_helpers.py -q && uv run python -c "from evaluatorq.common.reports import kpi_cards, render_heatmap, svg_donut; print('ok')"`
Expected: PASS + `ok`.

- [ ] **Step 7: Commit**

```bash
git add src/evaluatorq/common/reports/html_helpers.py src/evaluatorq/common/reports/__init__.py tests/common/reports/test_html_helpers.py
git commit -m "feat(evaluatorq-py): kpi cards + status badge primitives, export from common (RES-846)"
```

---

## Phase 2 — CSS overhaul

### Task 2.1: Add hero/card/status/heatmap/sparkline/mobile CSS

**Files:**
- Modify: `src/evaluatorq/common/reports/report.css`
- Test: `tests/common/reports/test_html_helpers.py` (assert key classes load)

- [ ] **Step 1: Write the failing test**

```python
from evaluatorq.common.reports.html_helpers import load_css


def test_report_css_has_new_design_tokens():
    css = load_css()
    for token in [
        ".hero", ".kpi-band", ".kpi-card", ".report-card", ".chart-card",
        ".status-badge--pass", ".status-badge--fail", ".heatmap-table",
        ".heatmap-cell", ".sparkline", "@media",
    ]:
        assert token in css, f"missing {token}"
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/common/reports/test_html_helpers.py::test_report_css_has_new_design_tokens -v`
Expected: FAIL.

- [ ] **Step 3: Append the design system to `report.css`**

Append (keep existing rules; add CSS variables at `:root` if not present):

```css
:root {
  --c-pass: #2ebd85; --c-fail: #d92d20; --c-warn: #f2b600; --c-neutral: #025558;
  --c-ink: #25232e; --c-sand: #f9f8f6; --c-border: #e4e2df;
}
.hero { padding: 1.5rem 0 1rem; border-bottom: 3px solid var(--c-neutral); margin-bottom: 1.5rem; }
.hero h1 { font-size: 2rem; margin: 0 0 .25rem; }
.kpi-band { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1rem 0 1.5rem; }
.kpi-card { flex: 1 1 140px; padding: 1rem 1.25rem; border-radius: 10px; background: var(--c-sand);
  border-left: 5px solid var(--c-neutral); }
.kpi-card--pass { border-left-color: var(--c-pass); }
.kpi-card--fail { border-left-color: var(--c-fail); }
.kpi-card--warn { border-left-color: var(--c-warn); }
.kpi-value { font-size: 1.9rem; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; }
.kpi-label { font-size: .82rem; color: #666; margin-top: .35rem; }
.report-card { background: #fff; border: 1px solid var(--c-border); border-radius: 12px;
  padding: 1.25rem 1.5rem; margin: 1.25rem 0; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
.report-card > h2 { margin-top: 0; }
.chart-card { margin: 1rem 0; text-align: center; }
.chart-card figcaption { font-weight: 600; font-size: .9rem; margin-bottom: .5rem; color: #444; }
.chart-card svg { max-width: 100%; height: auto; }
.donut-center { font-size: 1.6rem; font-weight: 800; fill: var(--c-ink); }
.bar-label, .bar-value { font-size: .75rem; fill: #444; }
.axis { stroke: var(--c-border); stroke-width: 1; }
.legend { display: flex; flex-wrap: wrap; gap: .75rem; justify-content: center; font-size: .78rem; margin-top: .5rem; }
.legend-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; }
.status-badge { display: inline-block; padding: .12rem .5rem; border-radius: 999px; font-size: .75rem;
  font-weight: 700; color: #fff; }
.status-badge--pass { background: var(--c-pass); }
.status-badge--fail { background: var(--c-fail); }
.status-badge--warn { background: var(--c-warn); color: var(--c-ink); }
.status-badge--neutral { background: var(--c-neutral); }
.heatmap-table { border-collapse: collapse; font-size: .8rem; }
.heatmap-table th, .heatmap-table td { padding: 2px; }
.heatmap-row-label { text-align: right; padding-right: 8px !important; white-space: nowrap; }
.heatmap-cell { display: block; min-width: 48px; padding: 6px 8px; border-radius: 4px; color: #fff;
  text-align: center; font-weight: 600; }
.heatmap-cell--safety { outline: 2px solid var(--c-ink); outline-offset: -2px; }
.sparkline { width: 80px; height: 20px; vertical-align: middle; }
td .sparkline rect, th .sparkline rect { shape-rendering: crispEdges; }
@media (max-width: 640px) {
  .kpi-card { flex: 1 1 100%; }
  .report-card { padding: 1rem; }
  table:not(.heatmap-table) thead { display: none; }
  table:not(.heatmap-table) tr { display: block; margin-bottom: .75rem; border: 1px solid var(--c-border); border-radius: 8px; }
  table:not(.heatmap-table) td { display: flex; justify-content: space-between; border: none; padding: .35rem .6rem; }
  table:not(.heatmap-table) td::before { content: attr(data-label); font-weight: 600; color: #666; }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/common/reports/test_html_helpers.py::test_report_css_has_new_design_tokens -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/common/reports/report.css tests/common/reports/test_html_helpers.py
git commit -m "feat(evaluatorq-py): report.css design system - hero, cards, status, heatmap, mobile (RES-846)"
```

---

## Phase 3 — Runner data fixes

### Task 3.1: Emit id-keyed `criteria_meta` (and keep `criteria_results`)

**Files:**
- Modify: `src/evaluatorq/simulation/runner/simulation.py:130-140` and the three `SimulationResult(...)` construction sites that set `criteria_results` / metadata (around lines 157-174, ~533, ~537).
- Test: `tests/simulation/test_runner_criteria_meta.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# tests/simulation/test_runner_criteria_meta.py
from evaluatorq.simulation.runner.simulation import _build_criteria_meta
from evaluatorq.simulation.types import Criterion, Judgment, Scenario


def _scenario() -> Scenario:
    return Scenario(
        name="billing", goal="g", context="c",
        criteria=[
            Criterion(description="explain charge", type="must_happen"),
            Criterion(description="no rudeness", type="must_not_happen"),
        ],
    )


def test_build_criteria_meta_is_id_keyed_with_type_and_passed():
    judgment = Judgment(
        should_terminate=True, reason="r", goal_achieved=False,
        rules_broken=["criteria_0"], goal_completion_score=0.0,
    )
    meta = _build_criteria_meta(_scenario(), judgment)
    assert meta == [
        {"id": "criteria_0", "description": "explain charge", "type": "must_happen", "passed": False},
        {"id": "criteria_1", "description": "no rudeness", "type": "must_not_happen", "passed": True},
    ]


def test_build_criteria_meta_survives_duplicate_descriptions():
    scenario = Scenario(
        name="s", goal="g", context="c",
        criteria=[
            Criterion(description="same text", type="must_happen"),
            Criterion(description="same text", type="must_happen"),
        ],
    )
    judgment = Judgment(
        should_terminate=True, reason="r", goal_achieved=False,
        rules_broken=["criteria_1"], goal_completion_score=0.0,
    )
    meta = _build_criteria_meta(scenario, judgment)
    # both criteria preserved despite identical descriptions
    assert len(meta) == 2
    assert meta[0]["passed"] is True and meta[1]["passed"] is False
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/simulation/test_runner_criteria_meta.py -v`
Expected: FAIL (`ImportError: _build_criteria_meta`).

- [ ] **Step 3: Implement `_build_criteria_meta` and wire it into metadata**

Add next to `_build_criteria_results` in `simulation.py`:

```python
def _build_criteria_meta(scenario: Scenario, judgment: Judgment) -> list[dict[str, object]]:
    """Id-keyed criteria detail for the report. Stable ids avoid the
    description-collision data loss that ``criteria_results`` (dict-by-description)
    suffers when two criteria share a description."""
    criteria = scenario.criteria or []
    rules_broken = set(judgment.rules_broken)
    meta: list[dict[str, object]] = []
    for i, criterion in enumerate(criteria):
        criterion_id = f"criteria_{i}"
        meta.append({
            "id": criterion_id,
            "description": criterion.description,
            "type": criterion.type,
            "passed": criterion_id not in rules_broken,
        })
    return meta
```

Then at each `SimulationResult(...)` site that builds `criteria_results` from a scenario + judgment, also compute `criteria_meta` and add it to that result's `metadata` dict, e.g. in `_max_turns_result`:

```python
    criteria_results = (
        _build_criteria_results(scenario, last_judgment)
        if scenario and last_judgment
        else None
    )
    criteria_meta = (
        _build_criteria_meta(scenario, last_judgment)
        if scenario and last_judgment
        else None
    )
    return SimulationResult(
        ...,
        criteria_results=criteria_results,
        metadata={
            "persona": persona.name if persona else None,
            "scenario": scenario.name if scenario else None,
            "criteria_meta": criteria_meta,
        },
    )
```

Apply the same `criteria_meta` addition at the other two construction sites (the judge-terminated result near line 533-537 and any other site that sets `criteria_results`). Where the site already builds a `metadata` dict, add the `"criteria_meta"` key; do not drop existing keys.

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/simulation/test_runner_criteria_meta.py -v`
Expected: PASS.

- [ ] **Step 5: Run simulation unit suite**

Run: `uv run pytest tests/simulation -m 'not integration' -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/evaluatorq/simulation/runner/simulation.py tests/simulation/test_runner_criteria_meta.py
git commit -m "feat(evaluatorq-py): emit id-keyed criteria_meta from runner (RES-846)"
```

### Task 3.2: Target model provenance (`metadata["target_model"]`)

**Files:**
- Modify: `src/evaluatorq/simulation/runner/simulation.py` (target response path + result metadata)
- Test: `tests/simulation/test_runner_criteria_meta.py` (add a metadata test) or a focused new test.

- [ ] **Step 1: Inspect the target response path**

Read `_get_target_response` and the `AgentTarget` protocol (`evaluatorq.contracts`). Confirm: `AgentTarget` responses may carry a model identity; `target_callback` returns plain text (no model). Do NOT use `self._model` (simulator/judge model) for `target_model`.

- [ ] **Step 2: Write the failing test**

```python
def test_target_model_omitted_when_unknown(monkeypatch):
    # A plain callable target cannot report its model -> metadata has no target_model
    from evaluatorq.simulation.types import SimulationResult
    # Build via the helper path used for callback targets; assert key absent/None.
    # (Construct minimal inputs per the runner's callback result builder.)
    ...
```

Replace the `...` with a concrete construction mirroring the runner's callback result path (use the same helper the runner calls to assemble a `SimulationResult` for a callback target). Assert `result.metadata.get("target_model") is None`.

- [ ] **Step 3: Run to verify fail**

Run: `uv run pytest tests/simulation/test_runner_criteria_meta.py -k target_model -v`
Expected: FAIL.

- [ ] **Step 4: Implement target_model capture**

In the target-response path, when the target is an `AgentTarget` that exposes a model (attribute `model` or a value returned alongside `(text, usage)`), set a local `target_model` and add `metadata["target_model"] = target_model` on the result. For `target_callback` targets leave it unset (do not add the key, or set `None`). Never assign `self._model`.

- [ ] **Step 5: Run to verify pass**

Run: `uv run pytest tests/simulation/test_runner_criteria_meta.py -k target_model -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/evaluatorq/simulation/runner/simulation.py tests/simulation/test_runner_criteria_meta.py
git commit -m "feat(evaluatorq-py): capture target_model provenance, never infer from runner (RES-846)"
```

---

## Phase 4 — Simulation section builders

Section data is renderer-agnostic. Helpers `_persona_name`, `_scenario_name`, `_model_name` already exist in `sections.py`.

### Task 4.1: Add `_criteria_meta` accessor + enriched summary KPIs

**Files:**
- Modify: `src/evaluatorq/simulation/reports/sections.py`
- Test: `tests/simulation/reports/test_sections.py`

- [ ] **Step 1: Write the failing test**

```python
# add to tests/simulation/reports/test_sections.py
from evaluatorq.simulation.reports.sections import build_report_sections, _criteria_rows


def test_summary_section_has_hero_kpis(make_result):
    results = [make_result(goal_achieved=True, score=1.0), make_result(goal_achieved=False, score=0.0)]
    summary = next(s for s in build_report_sections(results) if s.kind == "summary")
    d = summary.data
    assert d["total_conversations"] == 2
    assert d["goals_achieved"] == 1
    assert d["success_rate"] == 0.5
    assert "verdict" in d  # "pass" | "warn" | "fail"


def test_criteria_rows_uses_meta_ids_not_descriptions(make_result):
    r = make_result(
        goal_achieved=False, score=0.0,
        criteria_meta=[
            {"id": "criteria_0", "description": "explain charge", "type": "must_happen", "passed": False},
        ],
    )
    rows = _criteria_rows(r)
    assert rows[0]["id"] == "criteria_0"
    assert rows[0]["description"] == "explain charge"
    assert rows[0]["passed"] is False
    assert rows[0]["safety"] is False  # must_happen miss is not a safety violation
```

Add a `make_result` fixture at the top of the test file if not present:

```python
import pytest
from evaluatorq.simulation.types import SimulationResult, TerminatedBy, TokenUsage


@pytest.fixture
def make_result():
    def _make(*, goal_achieved=True, score=1.0, persona="P", scenario="S",
              criteria_meta=None, turn_count=1, terminated_by=TerminatedBy.judge):
        meta = {"persona": persona, "scenario": scenario}
        if criteria_meta is not None:
            meta["criteria_meta"] = criteria_meta
        return SimulationResult(
            messages=[], terminated_by=terminated_by, reason="r",
            goal_achieved=goal_achieved, goal_completion_score=score,
            rules_broken=[], turn_count=turn_count, turn_metrics=[],
            token_usage=TokenUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            metadata=meta,
        )
    return _make
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/simulation/reports/test_sections.py -k "hero or criteria_rows" -v`
Expected: FAIL.

- [ ] **Step 3: Implement accessor + enrich `_build_summary_section`**

Add to `sections.py`:

```python
def _criteria_meta(result: SimulationResult) -> list[dict]:
    raw = result.metadata.get("criteria_meta")
    if isinstance(raw, list):
        return [c for c in raw if isinstance(c, dict)]
    # Fallback to lossy criteria_results (no ids/type).
    cr = result.criteria_results or {}
    return [
        {"id": f"criteria_{i}", "description": desc, "type": None, "passed": bool(passed)}
        for i, (desc, passed) in enumerate(cr.items())
    ]


def _criteria_rows(result: SimulationResult) -> list[dict]:
    rows = []
    for c in _criteria_meta(result):
        is_safety = (c.get("type") == "must_not_happen") and not c.get("passed", True)
        rows.append({
            "id": c["id"],
            "description": c.get("description", c["id"]),
            "type": c.get("type"),
            "passed": bool(c.get("passed", True)),
            "safety": is_safety,
        })
    return rows
```

In `_build_summary_section`, add to the returned `data` dict a `verdict` key:

```python
    success_rate = (achieved / total) if total else 0.0
    verdict = "pass" if success_rate >= 0.8 else ("warn" if success_rate >= 0.5 else "fail")
    # ... include "verdict": verdict in data, alongside existing fields
```

(Keep all existing summary fields; only add `verdict`.)

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/simulation/reports/test_sections.py -k "hero or criteria_rows" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/simulation/reports/sections.py tests/simulation/reports/test_sections.py
git commit -m "feat(evaluatorq-py): criteria_meta accessor + summary verdict (RES-846)"
```

### Task 4.2: `failures_first` section builder

**Files:**
- Modify: `src/evaluatorq/simulation/reports/sections.py`
- Test: `tests/simulation/reports/test_sections.py`

- [ ] **Step 1: Write the failing test**

```python
def test_failures_first_lists_only_failures_with_descriptions(make_result):
    results = [
        make_result(goal_achieved=True, score=1.0, persona="A", scenario="X"),
        make_result(goal_achieved=False, score=0.0, persona="B", scenario="Y",
                    criteria_meta=[{"id": "criteria_0", "description": "explain charge",
                                    "type": "must_happen", "passed": False}]),
    ]
    section = next(s for s in build_report_sections(results) if s.kind == "failures_first")
    assert len(section.data["rows"]) == 1
    row = section.data["rows"][0]
    assert row["persona"] == "B" and row["scenario"] == "Y"
    assert row["violated"] == ["explain charge"]
    assert "criteria_0" not in str(row["violated"])  # description shown, not id
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/simulation/reports/test_sections.py -k failures_first -v`
Expected: FAIL (kind not produced).

- [ ] **Step 3: Implement builder + register**

```python
def _build_failures_first_section(results: list[SimulationResult]) -> ReportSection:
    rows = []
    for idx, r in enumerate(results):
        if r.goal_achieved or _is_errored(r):
            continue
        violated = [c["description"] for c in _criteria_rows(r) if not c["passed"]]
        rows.append({
            "index": idx + 1,
            "persona": _persona_name(r),
            "scenario": _scenario_name(r),
            "violated": violated,
            "has_safety": any(c["safety"] for c in _criteria_rows(r)),
            "terminated_by": r.terminated_by.value,
            "score": r.goal_completion_score,
            "anchor": f"conv-{idx + 1}",
        })
    return ReportSection(kind="failures_first", title="Failures", data={"rows": rows})
```

Register near the top of `build_report_sections`, right after the summary:

```python
    sections.append(_build_summary_section(results))
    sections.append(_build_failures_first_section(results))
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/simulation/reports/test_sections.py -k failures_first -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/simulation/reports/sections.py tests/simulation/reports/test_sections.py
git commit -m "feat(evaluatorq-py): failures-first section builder (RES-846)"
```

### Task 4.3: `criteria_heatmap`, `persona_scenario_heatmap`, `score_distribution`, `turn_quality_timeline`, `failure_mode`

**Files:**
- Modify: `src/evaluatorq/simulation/reports/sections.py`
- Test: `tests/simulation/reports/test_sections.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_new_section_kinds_present(make_result):
    results = [
        make_result(goal_achieved=False, score=0.2, persona="A", scenario="X",
                    criteria_meta=[{"id": "criteria_0", "description": "d0", "type": "must_happen", "passed": False}]),
        make_result(goal_achieved=True, score=0.9, persona="A", scenario="Y", criteria_meta=[]),
    ]
    kinds = {s.kind for s in build_report_sections(results)}
    for k in ["criteria_heatmap", "persona_scenario_heatmap", "score_distribution",
              "turn_quality_timeline", "failure_mode"]:
        assert k in kinds


def test_persona_scenario_heatmap_matrix(make_result):
    results = [
        make_result(goal_achieved=True, persona="A", scenario="X"),
        make_result(goal_achieved=False, persona="A", scenario="Y"),
    ]
    s = next(x for x in build_report_sections(results) if x.kind == "persona_scenario_heatmap")
    assert s.data["personas"] == ["A"]
    assert set(s.data["scenarios"]) == {"X", "Y"}
    # success-rate cell for (A, X) == 1.0, (A, Y) == 0.0
    cell = {(c["persona"], c["scenario"]): c["success_rate"] for c in s.data["cells"]}
    assert cell[("A", "X")] == 1.0 and cell[("A", "Y")] == 0.0
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/simulation/reports/test_sections.py -k "new_section_kinds or persona_scenario_heatmap" -v`
Expected: FAIL.

- [ ] **Step 3: Implement the five builders + register**

```python
def _build_criteria_heatmap_section(results: list[SimulationResult]) -> ReportSection:
    # rows = unique (id, description); cols = conversations
    col_labels = [f"#{i + 1}" for i in range(len(results))]
    by_id: dict[str, str] = {}
    order: list[str] = []
    for r in results:
        for c in _criteria_rows(r):
            if c["id"] not in by_id:
                by_id[c["id"]] = c["description"]
                order.append(c["id"])
    cells = []  # cells[row][col] in {1.0 pass, 0.0 fail, -1 absent}
    safety = []
    for cid in order:
        row_vals, row_safe = [], []
        for r in results:
            match = next((c for c in _criteria_rows(r) if c["id"] == cid), None)
            if match is None:
                row_vals.append(-1.0)
                row_safe.append(False)
            else:
                row_vals.append(1.0 if match["passed"] else 0.0)
                row_safe.append(match["safety"])
        cells.append(row_vals)
        safety.append(row_safe)
    return ReportSection(
        kind="criteria_heatmap", title="Criteria Pass/Fail",
        data={"x_labels": col_labels, "y_ids": order,
              "y_labels": [by_id[i] for i in order], "cells": cells, "safety": safety},
    )


def _build_persona_scenario_heatmap_section(results: list[SimulationResult]) -> ReportSection:
    personas, scenarios = [], []
    agg: dict[tuple[str, str], list[bool]] = defaultdict(list)
    for r in results:
        p, s = _persona_name(r), _scenario_name(r)
        if p not in personas:
            personas.append(p)
        if s not in scenarios:
            scenarios.append(s)
        agg[(p, s)].append(r.goal_achieved)
    cells = [
        {"persona": p, "scenario": s,
         "success_rate": (sum(v) / len(v)) if v else 0.0, "n": len(v)}
        for (p, s), v in agg.items()
    ]
    return ReportSection(
        kind="persona_scenario_heatmap", title="Persona x Scenario Success",
        data={"personas": personas, "scenarios": scenarios, "cells": cells},
    )


def _build_score_distribution_section(results: list[SimulationResult]) -> ReportSection:
    return ReportSection(
        kind="score_distribution", title="Goal Score Distribution",
        data={"scores": [r.goal_completion_score for r in results]},
    )


def _build_turn_quality_timeline_section(results: list[SimulationResult]) -> ReportSection:
    metrics = ("response_quality", "hallucination_risk", "tone_appropriateness", "factual_accuracy")
    by_turn: dict[int, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for r in results:
        for tm in r.turn_metrics:
            for m in metrics:
                val = getattr(tm, m, None)
                if val is not None:
                    by_turn[tm.turn_number][m].append(val)
    turns = sorted(by_turn)
    series = {
        m: [
            (sum(by_turn[t][m]) / len(by_turn[t][m])) if by_turn[t][m] else 0.0
            for t in turns
        ]
        for m in metrics
    }
    return ReportSection(
        kind="turn_quality_timeline", title="Turn Quality Timeline",
        data={"turns": turns, "series": series},
    )


def _build_failure_mode_section(results: list[SimulationResult]) -> ReportSection:
    counts: Counter[str] = Counter()
    for r in results:
        if r.goal_achieved:
            continue
        scen = _scenario_name(r)
        for c in _criteria_rows(r):
            if not c["passed"]:
                counts[f"{scen}: {c['description']}"] += 1
    return ReportSection(
        kind="failure_mode", title="Failure Modes",
        data={"rows": counts.most_common(15)},
    )
```

Register in `build_report_sections` in this order (after `failures_first`, before existing breakdowns):

```python
    sections.append(_build_persona_scenario_heatmap_section(results))
    sections.append(_build_criteria_heatmap_section(results))
    sections.append(_build_score_distribution_section(results))
    sections.append(_build_turn_quality_timeline_section(results))
    # ... existing persona/scenario breakdowns, judge verdicts, evaluator, then:
    sections.append(_build_failure_mode_section(results))
    # ... token usage, errors, individual results (unchanged tail)
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/simulation/reports/test_sections.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/simulation/reports/sections.py tests/simulation/reports/test_sections.py
git commit -m "feat(evaluatorq-py): heatmap/distribution/timeline/failure-mode section builders (RES-846)"
```

---

## Phase 5 — Simulation HTML renderers + hero/card layout

### Task 5.1: Hero band + card wrapping in the HTML document

**Files:**
- Modify: `src/evaluatorq/simulation/reports/export_html.py`
- Test: `tests/simulation/reports/test_export.py`

- [ ] **Step 1: Write the failing test**

```python
# add to tests/simulation/reports/test_export.py
from evaluatorq.simulation.reports import export_html


def test_html_has_hero_kpis_and_cards(sample_results):
    html = export_html(sample_results, target="Acme support agent")
    assert 'class="hero"' in html
    assert 'class="kpi-band"' in html
    assert 'class="report-card"' in html
    assert "Acme support agent" in html


def test_html_no_raw_criteria_id_leak(sample_results):
    html = export_html(sample_results, target="t")
    assert "criteria_0" not in html
    assert "criteria_1" not in html


def test_html_renders_without_plotly(sample_results, monkeypatch):
    import builtins
    real_import = builtins.__import__
    def no_plotly(name, *a, **k):
        if name.startswith("plotly") or name == "kaleido":
            raise ImportError(name)
        return real_import(name, *a, **k)
    monkeypatch.setattr(builtins, "__import__", no_plotly)
    html = export_html(sample_results, target="t")
    assert "<svg" in html  # charts still render (hand-SVG)
```

Add a `sample_results` fixture if the file lacks one (reuse the `make_result` shape: a list mixing achieved/failed with `criteria_meta` and at least one `turn_metrics` entry).

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/simulation/reports/test_export.py -k "hero or criteria_id_leak or without_plotly" -v`
Expected: FAIL.

- [ ] **Step 3: Build hero + switch body to cards**

In `export_html`, replace the `header_html` block with a hero that includes a KPI band built from the summary section data, using `kpi_cards` and the `verdict`:

```python
from evaluatorq.common.reports import kpi_cards as _kpi_cards

    sd = summary_data
    verdict = sd.get("verdict", "neutral")
    kpis = _kpi_cards([
        {"label": "Success Rate", "value": _pct(sd.get("success_rate", 0.0)),
         "status": "pass" if verdict == "pass" else ("warn" if verdict == "warn" else "fail")},
        {"label": "Avg Score", "value": f"{sd.get('avg_goal_completion_score', 0.0):.2f}", "status": "neutral"},
        {"label": "Conversations", "value": str(sd.get("total_conversations", 0)), "status": "neutral"},
        {"label": "Errors", "value": str(sd.get("errors", 0)),
         "status": "warn" if sd.get("errors", 0) else "neutral"},
    ])
    header_html = (
        f'<header class="hero"><h1>Agent Simulation Report</h1>'
        f'<p><strong>Target:</strong> {_esc(target)} &nbsp;|&nbsp; '
        f'<strong>Date:</strong> {_format_date(run_date or datetime.now(tz=timezone.utc))}</p>'
        f'{kpis}</header>'
    )
```

Wrap each rendered section in a `.report-card`. The simplest approach: in the `_SECTION_RENDERERS` functions, return content already wrapped in `<section class="report-card">…</section>` (the summary renderer changes to drop the now-duplicated donut+table where appropriate). Keep `render.py`'s `render_html` as-is (it just concatenates fragments).

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/simulation/reports/test_export.py -k "hero or criteria_id_leak or without_plotly" -v`
Expected: PASS. (If `criteria_0` still leaks, find the renderer printing `rules_broken`/raw ids and switch it to `_criteria_rows` descriptions — Task 5.2.)

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/simulation/reports/export_html.py tests/simulation/reports/test_export.py
git commit -m "feat(evaluatorq-py): hero scorecard + card layout in simulation HTML (RES-846)"
```

### Task 5.2: New HTML section renderers (heatmaps, distribution, timeline, failures-first, failure-mode) + semantic colors + sparklines + criteria fix

**Files:**
- Modify: `src/evaluatorq/simulation/reports/export_html.py`
- Test: `tests/simulation/reports/test_export.py`

- [ ] **Step 1: Write the failing test**

```python
def test_html_renders_new_charts(sample_results):
    html = export_html(sample_results, target="t")
    assert "heatmap-table" in html          # criteria + persona/scenario heatmaps
    assert "Goal Score Distribution" in html
    assert "Turn Quality Timeline" in html
    assert "Failures" in html
    # achieved/failed rendered as semantic badges, not plain text
    assert "status-badge--fail" in html


def test_html_persona_rows_have_sparklines(sample_results):
    html = export_html(sample_results, target="t")
    assert "sparkline" in html
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/simulation/reports/test_export.py -k "new_charts or sparklines" -v`
Expected: FAIL.

- [ ] **Step 3: Implement renderers and register in `_SECTION_RENDERERS`**

Add renderers (each returns a `.report-card` section). Import the primitives:

```python
from evaluatorq.common.reports import (
    render_heatmap as _render_heatmap,
    render_histogram as _render_histogram,
    render_line_chart as _render_line_chart,
    render_sparkline as _render_sparkline,
    status_badge as _status_badge,
    scale_color as _scale_color,
)
from evaluatorq.common.reports.palette import ORQ_SCALE_GOOD_BAD
```

```python
def _render_failures_first_html(section: ReportSection) -> str:
    rows = section.data.get("rows", [])
    if not rows:
        return ('<section class="report-card"><h2>Failures</h2>'
                '<p>No failed conversations.</p></section>')
    trs = []
    for r in rows:
        badges = "".join(_status_badge(v, "fail") for v in r["violated"]) or "—"
        safety = _status_badge("SAFETY", "fail") if r["has_safety"] else ""
        trs.append(
            f'<tr><td><a href="#{r["anchor"]}">#{r["index"]}</a></td>'
            f'<td>{_esc(r["persona"])}</td><td>{_esc(r["scenario"])}</td>'
            f'<td>{badges} {safety}</td><td>{r["score"]:.2f}</td>'
            f'<td>{_esc(r["terminated_by"])}</td></tr>'
        )
    return (
        '<section class="report-card"><h2>Failures</h2>'
        '<table><thead><tr><th>#</th><th>Persona</th><th>Scenario</th>'
        '<th>Violated criteria</th><th>Score</th><th>Ended</th></tr></thead>'
        f'<tbody>{"".join(trs)}</tbody></table></section>'
    )


def _render_criteria_heatmap_html(section: ReportSection) -> str:
    d = section.data
    if not d.get("y_labels"):
        return ""
    heat = _render_heatmap(
        x_labels=d["x_labels"], y_labels=d["y_labels"], cells=d["cells"],
        scale=ORQ_SCALE_GOOD_BAD, title=section.title,
        value_fmt=lambda v: ("—" if v < 0 else ("PASS" if v >= 0.5 else "FAIL")),
        safety_mask=d["safety"],
    )
    return f'<section class="report-card">{heat}</section>'


def _render_persona_scenario_heatmap_html(section: ReportSection) -> str:
    d = section.data
    personas, scenarios = d["personas"], d["scenarios"]
    if not personas or not scenarios:
        return ""
    lookup = {(c["persona"], c["scenario"]): c for c in d["cells"]}
    cells = [[lookup.get((p, s), {}).get("success_rate", -1.0) for p in personas] for s in scenarios]
    heat = _render_heatmap(
        x_labels=personas, y_labels=scenarios, cells=cells,
        scale=ORQ_SCALE_GOOD_BAD, title=section.title,
        value_fmt=lambda v: ("—" if v < 0 else f"{v:.0%}"),
    )
    # NOTE: ORQ_SCALE_GOOD_BAD is good=low->green; success-rate is good=high.
    # Pass 1 - success_rate as the value so high success = green.
    return f'<section class="report-card">{heat}</section>'


def _render_score_distribution_html(section: ReportSection) -> str:
    hist = _render_histogram(values=section.data.get("scores", []), bins=10, title=section.title)
    return f'<section class="report-card">{hist}</section>' if hist else ""


def _render_turn_quality_timeline_html(section: ReportSection) -> str:
    d = section.data
    turns = d.get("turns", [])
    if not turns:
        return ""
    series = [(name, vals) for name, vals in d["series"].items()]
    chart = _render_line_chart(x_labels=[str(t) for t in turns], series=series, title=section.title)
    return f'<section class="report-card">{chart}</section>'


def _render_failure_mode_html(section: ReportSection) -> str:
    rows = section.data.get("rows", [])
    if not rows:
        return ""
    bar = _svg_bar(rows=[(label, count) for label, count in rows], title=section.title)
    return f'<section class="report-card">{bar}</section>'
```

Note the comment in `_render_persona_scenario_heatmap_html`: to get high-success = green, pass `success_rate` through a green-high scale. Use a reversed scale or `1 - rate` with `ORQ_SCALE_GOOD_BAD`. Pick one and make it explicit: define a green-high helper inline by passing `value=success_rate` against a scale whose 0 is red and 1 is green. Simplest: build `cells` as `success_rate` and use `scale=[[0,red],[1,green]]` from palette colors. Update the call accordingly so high rates render green.

Register all in `_SECTION_RENDERERS`. Update the existing persona/scenario breakdown renderers to append a `_render_sparkline(...)` cell built from each row's success rate, and to render ACHIEVED/NOT-ACHIEVED via `_status_badge`. Update the judge-verdicts / individual-results renderers to print criteria via `_criteria_rows` descriptions (NOT `rules_broken` ids), and add `id="conv-N"` anchors on each individual conversation block so failures-first links resolve.

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/simulation/reports/test_export.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/simulation/reports/export_html.py tests/simulation/reports/test_export.py
git commit -m "feat(evaluatorq-py): new HTML chart renderers + semantic colors + sparklines (RES-846)"
```

### Task 5.3: Fix `Model: unknown` + transcript truncation note in HTML

**Files:**
- Modify: `src/evaluatorq/simulation/reports/export_html.py`
- Test: `tests/simulation/reports/test_export.py`

- [ ] **Step 1: Write the failing test**

```python
def test_html_omits_model_row_when_unknown(make_result):
    from evaluatorq.simulation.reports import export_html
    r = make_result(goal_achieved=True)  # no target_model in metadata
    html = export_html([r], target="t")
    assert "Model:</strong> unknown" not in html
    assert ">unknown<" not in html  # no stray "unknown" model cell


def test_html_full_transcript_no_json_note(sample_results):
    from evaluatorq.simulation.reports import export_html
    html = export_html(sample_results, target="t")
    assert "full text in report JSON" not in html
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/simulation/reports/test_export.py -k "model_row or json_note" -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the individual-results renderer: read `result.metadata.get("target_model")`; render the Model row only when truthy. In HTML, render full transcript text inside `<details>` (drop the truncation + the "full text in report JSON" string). Keep `_truncate_html` usage only where a short preview is intentional, without the misleading note.

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/simulation/reports/test_export.py -k "model_row or json_note" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/simulation/reports/export_html.py tests/simulation/reports/test_export.py
git commit -m "fix(evaluatorq-py): omit unknown model row, drop misleading JSON note in HTML (RES-846)"
```

---

## Phase 6 — Simulation Markdown renderers

### Task 6.1: MD text equivalents for new sections + criteria fix

**Files:**
- Modify: `src/evaluatorq/simulation/reports/export_md.py`
- Modify: `src/evaluatorq/common/reports/md_helpers.py` (add `md_heatmap`, `md_badge`, `md_distribution` if reused)
- Test: `tests/simulation/reports/test_export.py`

- [ ] **Step 1: Write the failing test**

```python
from evaluatorq.simulation.reports import export_markdown


def test_md_has_new_sections_and_no_raw_ids(sample_results):
    md = export_markdown(sample_results, target="t")
    assert "Failures" in md
    assert "Persona x Scenario" in md or "Persona × Scenario" in md
    assert "Goal Score Distribution" in md
    assert "Turn Quality Timeline" in md
    assert "criteria_0" not in md and "criteria_1" not in md


def test_md_omits_model_when_unknown(make_result):
    md = export_markdown([make_result(goal_achieved=True)], target="t")
    assert "Model:** unknown" not in md
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/simulation/reports/test_export.py -k "md_has_new or md_omits_model" -v`
Expected: FAIL.

- [ ] **Step 3: Implement MD renderers**

Add MD renderers for `failures_first`, `persona_scenario_heatmap`, `criteria_heatmap`, `score_distribution`, `turn_quality_timeline`, `failure_mode` (tables / bar-rows). Render heatmaps as Markdown tables with `✓`/`✗`/`—` cells; distribution as `█`-bar rows; criteria via `_criteria_rows` descriptions. Omit the Model line when `target_model` is absent. Register them in the MD `_SECTION_RENDERERS`.

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/simulation/reports/test_export.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/simulation/reports/export_md.py src/evaluatorq/common/reports/md_helpers.py tests/simulation/reports/test_export.py
git commit -m "feat(evaluatorq-py): markdown renderers for new sections + criteria fix (RES-846)"
```

---

## Phase 7 — Redteam regression + end-to-end smoke

### Task 7.1: Redteam render regression (plotly present and absent)

**Files:**
- Create: `tests/redteam/reports/test_export_regression.py`

- [ ] **Step 1: Write the test**

```python
# tests/redteam/reports/test_export_regression.py
import builtins
import pytest
from evaluatorq.redteam.reports.export_html import export_html


@pytest.fixture
def redteam_report():
    # Build a minimal RedTeamReport via the existing test helpers/fixtures.
    # Reuse whatever factory the current redteam report tests use; import it here.
    from tests.redteam.reports.conftest import make_minimal_report  # if present
    return make_minimal_report()


def test_redteam_html_renders_with_plotly(redteam_report):
    html = export_html(redteam_report)
    assert "<html" in html and "</html>" in html


def test_redteam_html_renders_without_plotly(redteam_report, monkeypatch):
    real_import = builtins.__import__
    def no_plotly(name, *a, **k):
        if name.startswith("plotly") or name == "kaleido":
            raise ImportError(name)
        return real_import(name, *a, **k)
    monkeypatch.setattr(builtins, "__import__", no_plotly)
    html = export_html(redteam_report)
    assert "<html" in html and "</html>" in html  # degrades to tables, still valid
```

If no `make_minimal_report` helper exists, construct a minimal `RedTeamReport` inline using the redteam contracts (look at existing `tests/redteam` for the smallest valid fixture and copy it).

- [ ] **Step 2: Run to verify pass (or fix regressions)**

Run: `uv run pytest tests/redteam/reports/test_export_regression.py -v`
Expected: PASS. If the CSS/palette changes broke redteam rendering, fix the regression before continuing.

- [ ] **Step 3: Commit**

```bash
git add tests/redteam/reports/test_export_regression.py
git commit -m "test(evaluatorq-py): redteam HTML render regression with/without plotly (RES-846)"
```

### Task 7.2: Update the manual demo script + visual smoke

**Files:**
- Modify: `scripts/manual_tests/simulation_report_demo.py`

- [ ] **Step 1: Fix the `.env` path (Codex P2)**

Change `load_dotenv(Path(__file__).resolve().parents[3] / ".env")` to resolve the package-root `.env`: `parents[2]` is `packages/evaluatorq-py`. Use:

```python
load_dotenv(Path(__file__).resolve().parents[2] / ".env")
```

- [ ] **Step 2: Run the demo (requires ORQ_API_KEY)**

Run: `uv run python scripts/manual_tests/simulation_report_demo.py`
Expected: writes `report.html` + `report.md`; HTML contains `<svg`, `kpi-band`, `heatmap-table`, no `criteria_0`.

- [ ] **Step 3: Visual check**

Open `scripts/manual_tests/report.html` (or `agent-browser --allow-file-access open file://…` + screenshot). Confirm hero KPIs, heatmaps, score distribution, timeline, failures-first, semantic colors render; no plotly installed.

- [ ] **Step 4: Commit**

```bash
git add scripts/manual_tests/simulation_report_demo.py
git commit -m "fix(evaluatorq-py): demo script .env path resolves to package root (RES-846)"
```

### Task 7.3: Full suite, lint, types

- [ ] **Step 1: Run everything**

Run: `uv run pytest -m 'not integration' -q`
Expected: all PASS.

- [ ] **Step 2: Lint + format + types**

Run: `uv run ruff check src && uv run ruff format src && uv run basedpyright src/evaluatorq/common/reports src/evaluatorq/simulation/reports`
Expected: clean (or only pre-existing warnings).

- [ ] **Step 3: Commit any lint fixes**

```bash
git add -A && git commit -m "chore(evaluatorq-py): lint/format pass for report redesign (RES-846)"
```

---

## Self-Review Notes (spec coverage)

- Hero scorecard + verdict → Task 4.1, 5.1.
- Failures-first → 4.2, 5.2 (HTML), 6.1 (MD).
- Criteria heatmap (id-keyed, safety flag) → 3.1, 4.3, 5.2, 6.1.
- Persona×scenario heatmap → 4.3, 5.2, 6.1.
- Score distribution → 4.3, 5.2, 6.1.
- Turn-quality timeline → 4.3, 5.2, 6.1.
- Failure-mode bar (treemap replacement) → 4.3, 5.2, 6.1.
- Sparklines + semantic colors + cards + mobile → 1.6, 2.1, 5.2.
- `criteria_0` fix (no raw ids) → 3.1, 4.1, 5.x/6.x assertions.
- `Model: unknown` fix → 3.2, 5.3, 6.1.
- Transcript JSON-note fix → 5.3.
- Hand-SVG, plotly optional; redteam additive + not migrated → Phases 0-1 additive, 7.1 regression.
- Shared in common.reports → Phases 0-2.
- Palette consolidation + back-compat shim → 0.1, 0.2.

**Adversarial-review fixes embedded:** redteam not claimed to lose plotly (7.1 proves both paths); model never inferred from runner (3.2); criteria keyed by stable id, duplicate-description test (3.1).
