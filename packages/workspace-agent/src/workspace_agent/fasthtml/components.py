"""FastHTML UI components for workspace agent - Orq branded design."""

from fasthtml.common import *
from typing import Dict, Any, Optional

from ..shared import (
    PRESETS,
    DEFAULT_PROJECT_PATH,
    DEFAULT_API_KEY,
    AVAILABLE_MODELS,
)
# Chat is a separate page - see app.py /chat route

# =============================================================================
# Design System - Orq Brand Colors (Orange/White Theme)
# =============================================================================

STYLES = Style("""
:root {
    /* Primary - Orq Orange */
    --primary-400: #df5325;
    --primary-500: #b73e1c;
    --primary-600: #922f15;

    /* Accent - Light Orange */
    --accent-100: #fff3e9;
    --accent-200: #ffd7b5;
    --accent-300: #ff8f34;
    --accent-400: #df5325;
    --accent-500: #b73e1c;

    /* Highlight - Orange tones (replacing turquoise) */
    --turquoise-300: #fff3e9;
    --turquoise-400: #ff8f34;
    --turquoise-500: #df5325;

    /* Ink - Text (dark on light background) */
    --ink-400: #9b9b9b;
    --ink-500: #767676;
    --ink-600: #e0e0e0;
    --ink-700: #f5f5f5;
    --ink-800: #ffffff;
    --ink-900: #f6f2f0;

    /* Text colors for light theme */
    --text-primary: #141319;
    --text-secondary: #4a4a4a;
    --text-muted: #767676;

    /* Sand/White */
    --sand-100: #141319;
    --sand-200: #4a4a4a;
    --white: #ffffff;

    /* Status - Using orange for success to match Orq theme */
    --success-400: #df5325;
    --success-500: #b73e1c;
    --error-400: #d92d20;
    --warning-400: #f2b600;
    --info-400: #2f80ed;
}

* {
    box-sizing: border-box;
}

body {
    background: var(--ink-900);
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    margin: 0;
    min-height: 100vh;
}

.container {
    max-width: 900px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
    position: relative;
}

/* Cards */
.card {
    background: var(--white);
    border: 1px solid var(--ink-600);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.card-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 1rem;
}

/* Preset Cards */
.preset-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
}

.preset-card {
    background: var(--white);
    border: 2px solid var(--ink-600);
    border-radius: 10px;
    padding: 1.25rem 1rem;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s ease;
}

.preset-card:hover {
    background: var(--accent-100);
    border-color: var(--accent-200);
    transform: translateY(-2px);
}

.preset-card.selected {
    border-color: var(--primary-400);
    background: var(--accent-100);
    box-shadow: 0 0 20px rgba(223, 83, 37, 0.15);
}

.preset-icon {
    font-size: 2rem;
    margin-bottom: 0.5rem;
}

.preset-name {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-primary);
}

.preset-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
}

/* Form Elements */
.form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
}

.form-group {
    margin-bottom: 1rem;
}

.form-label {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 0.5rem;
}

.form-input {
    width: 100%;
    background: var(--white);
    border: 1px solid var(--ink-600);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    color: var(--text-primary);
    font-size: 0.9375rem;
    transition: all 0.2s ease;
}

.form-input:focus {
    outline: none;
    border-color: var(--primary-400);
    box-shadow: 0 0 0 3px rgba(223, 83, 37, 0.15);
}

.form-input::placeholder {
    color: var(--text-muted);
}

textarea.form-input {
    resize: vertical;
    min-height: 100px;
}

select.form-input {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23767676' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    padding-right: 2.5rem;
}

/* Collapsible */
.collapsible-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    padding: 0.5rem 0;
}

.collapsible-header:hover {
    color: var(--primary-400);
}

.collapsible-content {
    padding-top: 1rem;
}

/* Buttons */
.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.875rem 2rem;
    font-size: 1rem;
    font-weight: 600;
    border-radius: 10px;
    border: none;
    cursor: pointer;
    transition: all 0.2s ease;
}

.btn-primary {
    background: linear-gradient(135deg, var(--primary-500) 0%, var(--primary-400) 100%);
    color: white;
    box-shadow: 0 4px 15px rgba(183, 62, 28, 0.3);
}

.btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(183, 62, 28, 0.4);
}

.btn-secondary {
    background: var(--white);
    color: var(--text-primary);
    border: 1px solid var(--ink-600);
}

.btn-secondary:hover {
    background: var(--ink-700);
}

.btn-success {
    background: var(--success-400);
    color: white;
}

.btn-success:hover {
    background: var(--success-500);
}

.btn-danger {
    background: transparent;
    color: var(--error-400);
    border: 1px solid var(--error-400);
}

.btn-danger:hover {
    background: rgba(217, 45, 32, 0.1);
}

.btn-group {
    display: flex;
    gap: 1rem;
    margin-top: 1.5rem;
}

/* Progress */
.progress-step {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0;
    color: var(--text-muted);
    font-size: 0.9375rem;
}

.progress-step.active {
    color: var(--primary-400);
}

.progress-step.complete {
    color: var(--success-400);
}

.step-icon {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    background: var(--ink-600);
}

.progress-step.active .step-icon {
    background: var(--primary-400);
    color: white;
}

.progress-step.complete .step-icon {
    background: var(--success-400);
    color: white;
}

/* Spinner */
@keyframes spin {
    to { transform: rotate(360deg); }
}

.spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--ink-600);
    border-top-color: var(--primary-400);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

/* Horizontal Progress Bar */
.progress-bar-container {
    margin: 1rem 0;
    padding: 1rem;
    background: var(--accent-100);
    border-radius: 8px;
}

.progress-bar-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
}

.progress-bar-text {
    color: var(--text-primary);
}

.progress-bar-count {
    color: var(--primary-400);
    font-weight: 500;
}

.progress-bar-track {
    width: 100%;
    height: 8px;
    background: var(--accent-200);
    border-radius: 4px;
    overflow: hidden;
}

.progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--primary-500), var(--primary-400));
    border-radius: 4px;
    transition: width 0.3s ease;
    width: 0%;
}

.progress-bar-detail {
    margin-top: 0.5rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
}

/* Progress Stepper */
.progress-stepper {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0.5rem 0;
}

.progress-stepper .step-item {
    display: flex;
    align-items: stretch;
    gap: 1rem;
    position: relative;
}

.progress-stepper .step-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    width: 28px;
}

.step-circle {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid var(--text-muted);
    background: var(--white);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    color: var(--text-muted);
    transition: all 0.3s ease;
    position: relative;
    z-index: 1;
    flex-shrink: 0;
}

.step-circle .checkmark {
    display: none;
}

.step-line {
    width: 2px;
    flex: 1;
    min-height: 20px;
    background: var(--ink-600);
    transition: background 0.3s ease;
}

.progress-stepper .step-item:last-child .step-line {
    display: none;
}

.progress-stepper .step-content {
    padding-bottom: 1rem;
    flex: 1;
    display: flex;
    align-items: center;
    min-height: 28px;
}

.progress-stepper .step-item:last-child .step-content {
    padding-bottom: 0;
}

.step-label {
    font-size: 0.9375rem;
    color: var(--text-muted);
    transition: color 0.3s ease;
}

/* Active step */
.step-item.active .step-circle {
    border-color: var(--primary-400);
    background: var(--accent-100);
    color: var(--primary-400);
    box-shadow: 0 0 12px rgba(223, 83, 37, 0.3);
}

.step-item.active .step-label {
    color: var(--text-primary);
    font-weight: 500;
}

/* Pulsing animation for active step */
@keyframes pulse {
    0%, 100% { box-shadow: 0 0 12px rgba(223, 83, 37, 0.3); }
    50% { box-shadow: 0 0 20px rgba(223, 83, 37, 0.5); }
}

.step-item.active .step-circle {
    animation: pulse 2s ease-in-out infinite;
}

/* Completed step */
.step-item.complete .step-circle {
    border-color: var(--success-400);
    background: var(--success-400);
    color: white;
    animation: none;
}

.step-item.complete .step-circle .step-number {
    display: none;
}

.step-item.complete .step-circle .checkmark {
    display: block;
}

.step-item.complete .step-line {
    background: var(--success-400);
}

.step-item.complete .step-label {
    color: var(--success-400);
}

/* Error step */
.step-item.error .step-circle {
    border-color: var(--error-400);
    background: var(--error-400);
    color: white;
    animation: none;
}

.step-item.error .step-label {
    color: var(--error-400);
}

/* Plan Preview */
.plan-section {
    margin-bottom: 1.5rem;
}

.plan-section-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.plan-item {
    background: var(--white);
    border: 1px solid var(--ink-600);
    border-radius: 8px;
    margin-bottom: 0.75rem;
    overflow: hidden;
}

.plan-item summary {
    list-style: none;
}

.plan-item summary::-webkit-details-marker {
    display: none;
}

.plan-item-header {
    padding: 1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.plan-item-header:hover {
    background: var(--ink-700);
}

.plan-item-name {
    font-weight: 500;
    color: var(--text-primary);
}

.plan-item-content {
    padding: 1rem;
    border-top: 1px solid var(--ink-600);
    font-size: 0.875rem;
    color: var(--text-secondary);
}

.plan-item-content pre {
    background: var(--ink-700);
    padding: 0.75rem;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 0.8125rem;
    margin: 0.5rem 0;
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
    color: var(--text-primary);
}

/* Results */
.result-card {
    background: linear-gradient(135deg, rgba(223, 83, 37, 0.08) 0%, rgba(223, 83, 37, 0.04) 100%);
    border: 1px solid var(--accent-400);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1rem;
}

.result-metric {
    text-align: center;
    padding: 1rem;
}

.result-metric-value {
    font-size: 2.5rem;
    font-weight: 700;
    color: var(--accent-400);
}

.result-metric-label {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
}

.result-item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
    background: var(--ink-700);
    border-radius: 8px;
    margin-bottom: 0.75rem;
}

.result-item-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
}

.result-item-description {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    padding-left: 1.75rem;
}

.result-item-id {
    font-size: 0.75rem;
    color: var(--ink-400);
    padding-left: 1.75rem;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
}

.config-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
}

.config-item {
    background: var(--ink-700);
    padding: 0.75rem 1rem;
    border-radius: 8px;
}

.config-item-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--turquoise-400);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
}

.config-item-value {
    font-size: 0.9375rem;
    color: var(--sand-100);
}

.result-item-icon {
    color: var(--accent-400);
    font-weight: bold;
}

/* Error */
.error-box {
    background: rgba(217, 45, 32, 0.08);
    border: 1px solid var(--error-400);
    border-radius: 12px;
    padding: 1.5rem;
    color: var(--text-primary);
}

/* Header */
.header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 2.5rem;
}

.header-content {
    text-align: center;
    flex: 1;
}

.header-title {
    font-size: 2rem;
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 0.5rem;
}

.header-subtitle {
    color: var(--text-muted);
    font-size: 1.0625rem;
}

.header-actions {
    position: absolute;
    top: 1.5rem;
    right: 1.5rem;
}

/* Step indicator */
.step-indicator {
    display: flex;
    justify-content: center;
    gap: 2rem;
    margin-bottom: 2rem;
    padding: 1rem;
    background: var(--white);
    border: 1px solid var(--ink-600);
    border-radius: 10px;
}

.step-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-muted);
    font-size: 0.875rem;
}

.step-item.active {
    color: var(--primary-400);
    font-weight: 500;
}

.step-item.complete {
    color: var(--success-400);
}

.step-item.complete.clickable {
    cursor: pointer;
    transition: all 0.2s ease;
}

.step-item.complete.clickable:hover {
    color: var(--primary-400);
    transform: scale(1.05);
}

.step-item.skipped {
    color: var(--text-muted);
    opacity: 0.5;
}

.step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
}
""")

# =============================================================================
# Preset Icons
# =============================================================================

PRESET_ICONS = {
    "E-commerce (Fashion)": "🛒",
    "SaaS (B2B)": "💼",
    "Healthcare": "🏥",
    "Custom": "⚙️",
}

PRESET_DESCRIPTIONS = {
    "E-commerce (Fashion)": "Customer support & recommendations",
    "SaaS (B2B)": "Onboarding & technical support",
    "Healthcare": "Appointments & patient FAQs",
    "Custom": "Build from scratch",
}


# =============================================================================
# Layout Components
# =============================================================================


def render_page(content, step: int = 1):
    """Render the full page layout."""
    return Div(cls="container")(
        STYLES,
        render_header(),
        render_step_indicator(step),
        content,
    )


def render_header():
    """Render the page header with logo and chat button in top right."""
    return Div(cls="header")(
        Div(cls="header-content")(
            Img(
                src="/static/orq-logo.svg",
                alt="Orq.ai",
                style="width: 48px; height: 48px; margin-bottom: 0.75rem;",
            ),
            H1("Workspace Agent", cls="header-title"),
            P("Set up your AI workspace in minutes", cls="header-subtitle"),
        ),
        Div(cls="header-actions")(
            A(
                "💬 Chat",
                href="/chat",
                cls="btn",
                style="font-size: 0.875rem; padding: 0.5rem 1rem; background: var(--text-primary); color: white; border: none;",
            ),
        ),
    )


def render_step_indicator(current: int, skipped: list = None, hx_swap_oob: str = None):
    """Render the 5-stage step indicator.

    Args:
        current: Current stage number (1-5)
        skipped: List of stage numbers to show as skipped
        hx_swap_oob: If set to "true", enables HTMX out-of-band swap for partial updates
    """
    skipped = skipped or []
    steps = [
        (1, "Config"),
        (2, "Clarifications"),
        (3, "Prompts"),
        (4, "Datasets"),
        (5, "Complete"),
    ]

    def get_step_class(step_num):
        if step_num in skipped:
            return "skipped"
        elif step_num == current:
            return "active"
        elif step_num < current:
            return "complete clickable"
        return ""

    def make_step_item(step_num, name):
        """Create a step item, making completed steps clickable."""
        step_class = get_step_class(step_num)
        is_clickable = "clickable" in step_class

        attrs = {"cls": f"step-item {step_class}"}
        if is_clickable:
            attrs["hx_post"] = f"/go-to-step/{step_num}"
            attrs["hx_target"] = "#main-content"
            attrs["hx_swap"] = "innerHTML"

        return Div(**attrs)(
            Span(cls="step-dot"),
            Span(name),
        )

    # Build attributes for the container
    container_attrs = {"cls": "step-indicator", "id": "step-indicator"}
    if hx_swap_oob:
        container_attrs["hx_swap_oob"] = hx_swap_oob

    return Div(**container_attrs)(*[make_step_item(step, name) for step, name in steps])


# =============================================================================
# Form Components
# =============================================================================


def render_config_form():
    """Render the configuration form."""
    return Form(
        hx_post="/start",
        hx_target="#main-content",
        hx_swap="innerHTML",
    )(
        # Preset Selection
        Div(cls="card")(
            Div("Choose a Template", cls="card-title"),
            Div(cls="preset-grid", id="preset-grid")(
                *[
                    Div(
                        cls=f"preset-card {'selected' if name == 'E-commerce (Fashion)' else ''}",
                        onclick=f"selectPreset(this, '{name}')",
                        data_preset=name,
                    )(
                        Div(PRESET_ICONS.get(name, "📦"), cls="preset-icon"),
                        Div(name.split(" (")[0], cls="preset-name"),
                        Div(PRESET_DESCRIPTIONS.get(name, ""), cls="preset-desc"),
                    )
                    for name in PRESETS.keys()
                ]
            ),
            Input(
                type="hidden",
                name="preset",
                id="preset-input",
                value="E-commerce (Fashion)",
            ),
        ),
        # Company Details
        Div(cls="card")(
            Div("Company Details", cls="card-title"),
            Div(cls="form-grid")(
                Div(cls="form-group")(
                    Label("Company Type", cls="form-label", fr="company_type"),
                    Input(
                        type="text",
                        name="company_type",
                        id="company_type",
                        value=PRESETS["E-commerce (Fashion)"]["company_type"],
                        placeholder="e.g., E-commerce, SaaS, Healthcare",
                        cls="form-input",
                    ),
                ),
                Div(cls="form-group")(
                    Label("Industry", cls="form-label", fr="industry"),
                    Input(
                        type="text",
                        name="industry",
                        id="industry",
                        value=PRESETS["E-commerce (Fashion)"]["industry"],
                        placeholder="e.g., Fashion Retail, Fintech",
                        cls="form-input",
                    ),
                ),
            ),
            Div(cls="form-group")(
                Label("Specific Instructions", cls="form-label", fr="instructions"),
                Textarea(
                    PRESETS["E-commerce (Fashion)"]["instructions"],
                    name="instructions",
                    id="instructions",
                    placeholder="Describe what you want the AI to focus on...",
                    cls="form-input",
                    rows="3",
                ),
            ),
        ),
        # Advanced Settings (collapsible)
        Details(cls="card", open=False)(
            Summary(cls="collapsible-header")(
                Span("Advanced Settings", cls="card-title", style="margin-bottom: 0"),
            ),
            Div(cls="collapsible-content")(
                Div(cls="form-group")(
                    Label("Project Path", cls="form-label", fr="project_path"),
                    Input(
                        type="text",
                        name="project_path",
                        id="project_path",
                        value=DEFAULT_PROJECT_PATH,
                        cls="form-input",
                    ),
                ),
                Div(cls="form-group")(
                    Label("Customer API Key", cls="form-label", fr="customer_api_key"),
                    Input(
                        type="password",
                        name="customer_api_key",
                        id="customer_api_key",
                        value=DEFAULT_API_KEY,
                        placeholder="JWT token (starts with 'ey')",
                        cls="form-input",
                    ),
                ),
                Div(cls="form-grid")(
                    Div(cls="form-group")(
                        Label("Dataset Rows", cls="form-label", fr="num_rows"),
                        Input(
                            type="number",
                            name="num_rows",
                            id="num_rows",
                            value="5",
                            min="1",
                            max="20",
                            cls="form-input",
                        ),
                    ),
                    Div(cls="form-group")(
                        Label("Model", cls="form-label", fr="model"),
                        Select(
                            *[Option(m, value=m) for m in AVAILABLE_MODELS],
                            name="model",
                            id="model",
                            cls="form-input",
                        ),
                    ),
                ),
                Div(cls="form-grid")(
                    Div(cls="form-group")(
                        Label(
                            "Number of Datasets", cls="form-label", fr="num_datasets"
                        ),
                        Input(
                            type="number",
                            name="num_datasets",
                            id="num_datasets",
                            value="2",
                            min="1",
                            max="5",
                            cls="form-input",
                        ),
                    ),
                ),
            ),
        ),
        # Submit Button
        Div(style="text-align: center; margin-top: 2rem")(
            Button("Generate Plan", type="submit", cls="btn btn-primary"),
        ),
        # JavaScript for preset selection
        Script("""
            function selectPreset(el, name) {
                // Update selection state
                document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('selected'));
                el.classList.add('selected');
                document.getElementById('preset-input').value = name;

                // Fetch and update form values
                htmx.ajax('GET', '/preset-values?preset=' + encodeURIComponent(name), {
                    target: '#company_type',
                    swap: 'none'
                }).then(() => {
                    fetch('/preset-values?preset=' + encodeURIComponent(name))
                        .then(r => r.json())
                        .then(data => {
                            document.getElementById('company_type').value = data.company_type;
                            document.getElementById('industry').value = data.industry;
                            document.getElementById('instructions').value = data.instructions;
                        });
                });
            }
        """),
    )


# =============================================================================
# Clarification Components
# =============================================================================


def render_clarifying_state():
    """Render the state while generating clarification questions."""
    return Div(
        hx_ext="sse",
        sse_connect="/stream/clarifying",
        sse_swap="message",
        hx_target="#clarify-updates",
    )(
        Div(cls="card")(
            Div("Analyzing Requirements", cls="card-title"),
            render_progress_stepper(CLARIFICATION_STEPS, "clarify"),
            Div(id="clarify-updates", style="display: none"),
        ),
    )


def render_clarification_questions(
    questions: list, answers: dict, reasoning: Optional[str] = None
):
    """Render the 3 clarification questions with tabs and option buttons.

    Args:
        questions: List of question dicts with question text and options
        answers: Dict mapping question index to answer
        reasoning: Optional agent reasoning to display above questions
    """
    num_questions = len(questions)

    # Add CSS for tabs
    tab_styles = Style("""
    .tab-container {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 1.5rem;
        border-bottom: 2px solid var(--ink-600);
        padding-bottom: 0.5rem;
    }
    .tab-btn {
        padding: 0.75rem 1.5rem;
        background: transparent;
        border: none;
        color: var(--ink-400);
        cursor: pointer;
        font-size: 0.9375rem;
        font-weight: 500;
        border-radius: 8px 8px 0 0;
        transition: all 0.2s ease;
        position: relative;
    }
    .tab-btn:hover {
        color: var(--sand-100);
        background: var(--ink-700);
    }
    .tab-btn.active {
        color: var(--turquoise-400);
        background: var(--ink-700);
    }
    .tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: -2px;
        left: 0;
        right: 0;
        height: 2px;
        background: var(--turquoise-400);
    }
    .tab-btn.answered {
        color: var(--success-400);
    }
    .tab-btn.answered::before {
        content: '✓ ';
    }
    .tab-content {
        display: none;
    }
    .tab-content.active {
        display: block;
    }
    .question-text {
        font-size: 1.125rem;
        color: var(--sand-100);
        margin-bottom: 1.5rem;
        line-height: 1.5;
    }
    .option-grid {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }
    .option-btn {
        padding: 1rem 1.25rem;
        background: var(--ink-700);
        border: 2px solid var(--ink-600);
        border-radius: 10px;
        color: var(--sand-100);
        cursor: pointer;
        text-align: left;
        font-size: 0.9375rem;
        transition: all 0.2s ease;
        outline: none;
    }
    .option-btn:focus {
        outline: none;
        box-shadow: 0 0 0 3px rgba(223, 83, 37, 0.2);
    }
    .option-btn:hover {
        border-color: var(--accent-300);
        background: var(--ink-600);
    }
    .option-btn.selected {
        border-color: var(--accent-400);
        background: var(--accent-100);
    }
    .custom-answer {
        margin-top: 1rem;
    }
    """)

    # Build tab buttons
    tab_buttons = []
    for i in range(num_questions):
        is_answered = i in answers and answers[i]
        btn_class = "tab-btn"
        if i == 0:
            btn_class += " active"
        if is_answered:
            btn_class += " answered"
        tab_buttons.append(
            Button(
                f"Question {i + 1}",
                cls=btn_class,
                onclick=f"switchTab({i})",
                type="button",
            )
        )

    # Build tab contents
    tab_contents = []
    for i, q in enumerate(questions):
        question_text = q.get("question", "")
        options = q.get("options", [])
        current_answer = answers.get(i, "")

        content_class = "tab-content active" if i == 0 else "tab-content"
        tab_contents.append(
            Div(cls=content_class, id=f"tab-{i}", data_index=str(i))(
                Div(question_text, cls="question-text"),
                Div(cls="option-grid")(
                    *[
                        Button(
                            opt,
                            cls=f"option-btn {'selected' if current_answer == opt else ''}",
                            onclick=f"selectOption({i}, this, '{opt.replace(chr(39), chr(92) + chr(39))}')",
                            type="button",
                        )
                        for opt in options
                    ]
                ),
                Div(cls="custom-answer")(
                    Div(
                        "Or provide your own answer:",
                        style="color: var(--ink-400); font-size: 0.875rem; margin-bottom: 0.5rem",
                    ),
                    Input(
                        type="text",
                        placeholder="Type a custom answer...",
                        cls="form-input",
                        id=f"custom-{i}",
                        value=current_answer
                        if current_answer and current_answer not in options
                        else "",
                        onkeyup=f"customAnswer({i}, this.value)",
                    ),
                ),
            )
        )

    # Hidden inputs to store answers
    hidden_inputs = [
        Input(
            type="hidden",
            name=f"answer_{i}",
            id=f"answer-input-{i}",
            value=answers.get(i, ""),
        )
        for i in range(num_questions)
    ]

    # Check if all questions answered
    all_answered = all(i in answers and answers[i] for i in range(num_questions))

    # Build reasoning card if provided
    reasoning_card = None
    if reasoning:
        reasoning_card = Div(cls="card", style="margin-bottom: 1.5rem")(
            Div("Agent Reasoning", cls="card-title"),
            P(
                reasoning,
                style="color: var(--sand-100); line-height: 1.6",
            ),
        )

    return Div(
        tab_styles,
        reasoning_card,
        Div(cls="card")(
            Div("Clarification Questions", cls="card-title"),
            P(
                "Please answer these questions to help us create a better workspace plan.",
                style="color: var(--ink-400); margin-bottom: 1.5rem",
            ),
            # Tabs
            Div(cls="tab-container")(*tab_buttons),
            # Tab contents in a form
            Form(
                hx_post="/submit-clarification",
                hx_target="#main-content",
                id="clarification-form",
            )(
                *tab_contents,
                *hidden_inputs,
                # Submit button
                Div(cls="btn-group", style="justify-content: center; margin-top: 2rem")(
                    Button(
                        "Continue to Planning",
                        type="submit",
                        cls="btn btn-primary",
                        id="submit-clarification-btn",
                        disabled=not all_answered,
                    ),
                    Button(
                        "Skip Questions",
                        hx_post="/skip-clarification",
                        hx_target="#main-content",
                        cls="btn btn-secondary",
                        type="button",
                    ),
                    Button(
                        "Cancel",
                        hx_post="/cancel",
                        hx_target="#main-content",
                        cls="btn btn-danger",
                        type="button",
                    ),
                ),
            ),
        ),
        # JavaScript for tab switching and option selection
        Script("""
            function switchTab(index) {
                // Update tab buttons
                document.querySelectorAll('.tab-btn').forEach((btn, i) => {
                    btn.classList.toggle('active', i === index);
                });
                // Update tab contents
                document.querySelectorAll('.tab-content').forEach((content, i) => {
                    content.classList.toggle('active', i === index);
                });
            }

            function selectOption(questionIndex, btn, option) {
                // Update selection UI
                const container = btn.closest('.option-grid');
                container.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');

                // Clear custom input
                document.getElementById('custom-' + questionIndex).value = '';

                // Update hidden input
                document.getElementById('answer-input-' + questionIndex).value = option;

                // Update tab as answered
                document.querySelectorAll('.tab-btn')[questionIndex].classList.add('answered');

                checkAllAnswered();
            }

            function customAnswer(questionIndex, value) {
                if (value.trim()) {
                    // Clear option selection
                    document.querySelectorAll('#tab-' + questionIndex + ' .option-btn').forEach(b => b.classList.remove('selected'));

                    // Update hidden input
                    document.getElementById('answer-input-' + questionIndex).value = value.trim();

                    // Update tab as answered
                    document.querySelectorAll('.tab-btn')[questionIndex].classList.add('answered');
                } else {
                    // Clear answer
                    document.getElementById('answer-input-' + questionIndex).value = '';
                    document.querySelectorAll('.tab-btn')[questionIndex].classList.remove('answered');
                }

                checkAllAnswered();
            }

            function checkAllAnswered() {
                const inputs = document.querySelectorAll('[id^="answer-input-"]');
                const allAnswered = Array.from(inputs).every(input => input.value.trim() !== '');
                document.getElementById('submit-clarification-btn').disabled = !allAnswered;
            }
        """),
    )


def render_clarification_processing():
    """Render the state while processing clarification answers."""
    return Div(
        hx_ext="sse",
        sse_connect="/stream/clarification-summary",
        sse_swap="message",
        hx_swap="beforeend",
    )(
        Div(cls="card")(
            Div(
                style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem"
            )(
                Div(cls="spinner"),
                Span(
                    "Processing your answers...",
                    style="color: var(--sand-100); font-weight: 500",
                ),
            ),
            Div(id="summary-log")(
                # Progress steps will be inserted here via SSE
            ),
        ),
    )


# =============================================================================
# State Components
# =============================================================================


def render_progress_stepper(steps: list, phase: str = "planning"):
    """Render a visual progress stepper.

    Args:
        steps: List of (step_id, label) tuples
        phase: Phase identifier for unique IDs
    """
    step_items = []
    for i, (step_id, label) in enumerate(steps):
        step_items.append(
            Div(cls="step-item", id=f"{phase}-step-{step_id}")(
                Div(cls="step-indicator")(
                    Div(cls="step-circle")(
                        Span(str(i + 1), cls="step-number"),
                        Span("✓", cls="checkmark"),
                    ),
                    Div(cls="step-line"),
                ),
                Div(cls="step-content")(
                    Span(label, cls="step-label"),
                ),
            )
        )
    return Div(cls="progress-stepper", id=f"{phase}-stepper")(*step_items)


# Execution steps (simplified - only persistence now)
EXECUTION_STEPS = [
    ("init", "Initializing persistence"),
    ("persist", "Creating prompts and datasets"),
    ("complete", "Setup complete"),
]

# Clarification steps - IDs must match handler step_map
CLARIFICATION_STEPS = [
    ("init", "Initializing"),
    ("generate", "Generating questions"),
    ("complete", "Questions ready"),
]


# Prompt planning steps
PROMPT_PLANNING_STEPS = [
    ("init", "Initializing orchestrator"),
    ("create", "Creating workspace orchestrator"),
    ("plan", "Generating prompts"),
    ("complete", "Prompts ready"),
]

# Dataset planning steps (now includes datapoint generation)
DATASET_PLANNING_STEPS = [
    ("init", "Analyzing approved prompts"),
    ("generate", "Generating datasets and datapoints"),
    ("complete", "Datasets ready"),
]


def render_prompt_planning_state():
    """Render the state while generating prompts."""
    return Div(
        hx_ext="sse",
        sse_connect="/stream/planning-prompts",
        sse_swap="message",
        hx_target="#prompt-planning-updates",
    )(
        Div(cls="card")(
            Div("Generating Prompts", cls="card-title"),
            render_progress_stepper(PROMPT_PLANNING_STEPS, "prompt-planning"),
            Div(id="prompt-planning-updates", style="display: none"),
        ),
    )


def render_prompts_review(prompts: list):
    """Render the prompt review screen with full system prompts displayed."""
    # CSS for prompt review
    prompt_styles = Style("""
    .prompt-card {
        background: var(--ink-700);
        border: 1px solid var(--ink-600);
        border-radius: 12px;
        margin-bottom: 1rem;
        overflow: hidden;
    }
    .prompt-header {
        padding: 1rem 1.25rem;
        background: var(--ink-750);
        border-bottom: 1px solid var(--ink-600);
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .prompt-name {
        font-size: 1rem;
        font-weight: 600;
        color: var(--sand-100);
    }
    .prompt-meta {
        display: flex;
        gap: 1rem;
        font-size: 0.8125rem;
        color: var(--ink-400);
    }
    .prompt-body {
        padding: 1.25rem;
    }
    .prompt-section {
        margin-bottom: 1rem;
    }
    .prompt-section:last-child {
        margin-bottom: 0;
    }
    .prompt-section-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--turquoise-400);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 0.5rem;
    }
    .system-prompt-box {
        background: var(--ink-800);
        border: 1px solid var(--ink-600);
        border-radius: 8px;
        padding: 1rem;
        font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
        font-size: 0.8125rem;
        line-height: 1.6;
        color: var(--sand-200);
        white-space: pre-wrap;
        max-height: 200px;
        overflow-y: auto;
    }
    .template-box {
        background: var(--ink-800);
        border: 1px solid var(--ink-600);
        border-radius: 8px;
        padding: 1rem;
        font-size: 0.875rem;
        line-height: 1.5;
        color: var(--sand-100);
    }
    .template-var {
        color: var(--turquoise-400);
        font-weight: 500;
    }
    .message-item {
        background: var(--ink-800);
        border: 1px solid var(--ink-600);
        border-radius: 8px;
        padding: 0.75rem 1rem;
        margin-bottom: 0.5rem;
    }
    .message-item:last-child {
        margin-bottom: 0;
    }
    .message-role {
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 0.25rem;
        color: var(--ink-400);
    }
    .message-item.message-system .message-role {
        color: var(--turquoise-400);
    }
    .message-item.message-user .message-role {
        color: var(--primary-400);
    }
    .message-item.message-assistant .message-role {
        color: var(--success-400);
    }
    .message-content {
        font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
        font-size: 0.8125rem;
        line-height: 1.6;
        color: var(--sand-200);
        white-space: pre-wrap;
    }
    .prompt-edit-btn {
        background: transparent;
        border: 1px solid var(--ink-500);
        color: var(--ink-400);
        padding: 0.25rem 0.75rem;
        border-radius: 6px;
        font-size: 0.75rem;
        cursor: pointer;
        transition: all 0.2s ease;
    }
    .prompt-edit-btn:hover {
        border-color: var(--primary-400);
        color: var(--primary-400);
    }
    .prompt-edit-form {
        padding: 1.25rem;
    }
    .prompt-edit-form .form-group {
        margin-bottom: 1rem;
    }
    .prompt-edit-form .form-label {
        display: block;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--turquoise-400);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 0.5rem;
    }
    .prompt-edit-form .form-input,
    .prompt-edit-form .form-textarea,
    .prompt-edit-form .form-select {
        width: 100%;
        background: var(--ink-800);
        border: 1px solid var(--ink-600);
        border-radius: 8px;
        padding: 0.75rem;
        color: var(--sand-100);
        font-size: 0.875rem;
    }
    .prompt-edit-form .form-textarea {
        min-height: 150px;
        font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
        resize: vertical;
    }
    .prompt-edit-form .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
    }
    .prompt-edit-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 1rem;
    }
    """)

    prompt_cards = []
    for i, p in enumerate(prompts):
        prompt_cards.append(render_prompt_card(p, i))

    return Div(
        prompt_styles,
        Div(cls="card")(
            Div("Review Your Prompts", cls="card-title"),
            P(
                "These prompts will be used to create your datasets. Review them before proceeding.",
                style="color: var(--ink-400); margin-bottom: 1.5rem",
            ),
            *prompt_cards,
            Div(cls="btn-group", style="justify-content: center; margin-top: 1.5rem")(
                Button(
                    "Generate Datasets",
                    hx_post="/approve-prompts",
                    hx_target="#main-content",
                    cls="btn btn-success",
                ),
                Button(
                    "Regenerate Prompts",
                    hx_post="/regenerate-prompts",
                    hx_target="#main-content",
                    cls="btn btn-secondary",
                ),
                Button(
                    "Cancel",
                    hx_post="/cancel",
                    hx_target="#main-content",
                    cls="btn btn-danger",
                ),
            ),
        ),
    )


def render_prompt_card(p: dict, index: int):
    """Render a single prompt card in read-only mode."""
    name = p.get("name", f"Prompt {index + 1}")
    description = p.get("description", "")
    system_prompt = p.get("system_prompt", "")
    model = p.get("model", "gpt-4o-mini")
    temperature = p.get("temperature", 0.7)

    return Div(id=f"prompt-card-{index}", cls="prompt-card")(
        Div(cls="prompt-header")(
            Span(name, cls="prompt-name"),
            Div(style="display: flex; align-items: center; gap: 1rem")(
                Div(cls="prompt-meta")(
                    Span(f"Model: {model}"),
                    Span(f"Temp: {temperature}"),
                ),
                Button(
                    "Edit",
                    cls="prompt-edit-btn",
                    hx_get=f"/edit-prompt/{index}",
                    hx_target=f"#prompt-card-{index}",
                    hx_swap="outerHTML",
                ),
            ),
        ),
        Div(cls="prompt-body")(
            Div(cls="prompt-section")(
                Div("Description", cls="prompt-section-label"),
                P(description, style="color: var(--sand-200); margin: 0"),
            )
            if description
            else None,
            Div(cls="prompt-section")(
                Div("System Prompt", cls="prompt-section-label"),
                Div(system_prompt, cls="system-prompt-box"),
            )
            if system_prompt
            else None,
        ),
    )


def render_prompt_edit_form(p: dict, index: int):
    """Render an inline edit form for a prompt."""
    name = p.get("name", f"Prompt {index + 1}")
    description = p.get("description", "")
    system_prompt = p.get("system_prompt", "")
    model = p.get("model", "gpt-4o-mini")
    temperature = p.get("temperature", 0.7)

    return Div(id=f"prompt-card-{index}", cls="prompt-card")(
        Div(cls="prompt-header")(
            Span(f"Editing: {name}", cls="prompt-name"),
        ),
        Form(
            cls="prompt-edit-form",
            hx_post=f"/save-prompt/{index}",
            hx_target=f"#prompt-card-{index}",
            hx_swap="outerHTML",
        )(
            Div(cls="form-group")(
                Label("Name", cls="form-label"),
                Input(
                    type="text",
                    name="name",
                    value=name,
                    cls="form-input",
                ),
            ),
            Div(cls="form-group")(
                Label("Description", cls="form-label"),
                Input(
                    type="text",
                    name="description",
                    value=description,
                    cls="form-input",
                ),
            ),
            Div(cls="form-group")(
                Label("System Prompt", cls="form-label"),
                Textarea(
                    system_prompt,
                    name="system_prompt",
                    cls="form-textarea",
                ),
            ),
            Div(cls="form-row")(
                Div(cls="form-group")(
                    Label("Model", cls="form-label"),
                    Select(
                        Option(
                            "gpt-4o-mini",
                            value="gpt-4o-mini",
                            selected=(model == "gpt-4o-mini"),
                        ),
                        Option("gpt-4o", value="gpt-4o", selected=(model == "gpt-4o")),
                        Option(
                            "gpt-4-turbo",
                            value="gpt-4-turbo",
                            selected=(model == "gpt-4-turbo"),
                        ),
                        Option(
                            "google/gemini-2.5-flash",
                            value="google/gemini-2.5-flash",
                            selected=(model == "google/gemini-2.5-flash"),
                        ),
                        Option(
                            "anthropic/claude-sonnet-4-20250514",
                            value="anthropic/claude-sonnet-4-20250514",
                            selected=(model == "anthropic/claude-sonnet-4-20250514"),
                        ),
                        name="model",
                        cls="form-select",
                    ),
                ),
                Div(cls="form-group")(
                    Label(f"Temperature: {temperature}", cls="form-label"),
                    Input(
                        type="range",
                        name="temperature",
                        value=str(temperature),
                        min="0",
                        max="2",
                        step="0.1",
                        cls="form-input",
                    ),
                ),
            ),
            Div(cls="prompt-edit-actions")(
                Button("Save", type="submit", cls="btn btn-success"),
                Button(
                    "Cancel",
                    type="button",
                    cls="btn btn-secondary",
                    hx_get=f"/cancel-edit-prompt/{index}",
                    hx_target=f"#prompt-card-{index}",
                    hx_swap="outerHTML",
                ),
            ),
        ),
    )


def render_dataset_planning_state():
    """Render the state while generating datasets and datapoints."""
    return Div(
        hx_ext="sse",
        sse_connect="/stream/planning-datasets",
        sse_swap="message",
        hx_target="#dataset-planning-updates",
    )(
        Div(cls="card")(
            Div("Generating Datasets & Datapoints", cls="card-title"),
            render_progress_stepper(DATASET_PLANNING_STEPS, "dataset-planning"),
            # Datapoint progress bar (shown during datapoint generation)
            Div(
                id="datapoint-progress",
                cls="progress-bar-container",
                style="display: none",
            )(
                Div(cls="progress-bar-label")(
                    Span("Generating datapoints...", cls="progress-bar-text"),
                    Span("0 / 0", id="progress-bar-count", cls="progress-bar-count"),
                ),
                Div(cls="progress-bar-track")(
                    Div(id="progress-bar-fill", cls="progress-bar-fill"),
                ),
                Div(id="progress-bar-detail", cls="progress-bar-detail"),
            ),
            Div(id="dataset-planning-updates", style="display: none"),
        ),
    )


def render_datasets_review(datasets: list, prompts: Optional[list] = None):
    """Render the dataset review screen showing matched prompt linkage."""
    prompts = prompts or []
    # CSS for dataset review (reusing prompt card styles)
    dataset_styles = Style("""
    .dataset-card {
        background: var(--ink-700);
        border: 1px solid var(--ink-600);
        border-radius: 12px;
        margin-bottom: 1rem;
        overflow: hidden;
    }
    .dataset-header {
        padding: 1rem 1.25rem;
        background: var(--ink-750);
        border-bottom: 1px solid var(--ink-600);
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .dataset-name {
        font-size: 1rem;
        font-weight: 600;
        color: var(--sand-100);
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }
    .dataset-icon {
        color: var(--turquoise-400);
    }
    .dataset-meta {
        display: flex;
        gap: 1rem;
        font-size: 0.8125rem;
        color: var(--ink-400);
    }
    .dataset-body {
        padding: 1.25rem;
    }
    .dataset-section {
        margin-bottom: 1rem;
    }
    .dataset-section:last-child {
        margin-bottom: 0;
    }
    .dataset-section-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--turquoise-400);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 0.5rem;
    }
    .dataset-system-prompt {
        background: var(--ink-800);
        border: 1px solid var(--ink-600);
        border-radius: 8px;
        padding: 1rem;
        font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
        font-size: 0.8125rem;
        line-height: 1.6;
        color: var(--sand-200);
        white-space: pre-wrap;
        max-height: 200px;
        overflow-y: auto;
    }
    .dataset-fields {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    .dataset-field-tag {
        background: var(--ink-600);
        color: var(--sand-100);
        padding: 0.25rem 0.75rem;
        border-radius: 4px;
        font-size: 0.8125rem;
        font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
    }
    /* Table container for horizontal scroll */
    .datapoints-table-container {
        overflow-x: auto;
        margin-top: 0.5rem;
        border: 1px solid var(--ink-600);
        border-radius: 8px;
    }
    .datapoints-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.8125rem;
        min-width: max-content;
    }
    .datapoints-table th {
        background: var(--ink-750);
        color: var(--turquoise-400);
        padding: 0.5rem 0.75rem;
        text-align: left;
        font-weight: 600;
        text-transform: uppercase;
        font-size: 0.6875rem;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--ink-600);
        white-space: nowrap;
        position: sticky;
        top: 0;
    }
    .datapoints-table td {
        padding: 0.5rem 0.75rem;
        color: var(--sand-200);
        border-bottom: 1px solid var(--ink-700);
        vertical-align: top;
    }
    .datapoints-table tr:hover {
        background: var(--ink-750);
    }
    .datapoints-table .row-num {
        color: var(--ink-400);
        font-size: 0.75rem;
        width: 40px;
        position: sticky;
        left: 0;
        background: var(--ink-800);
    }
    .datapoints-table th:first-child {
        position: sticky;
        left: 0;
        z-index: 1;
    }
    /* Expandable cell content */
    .cell-content {
        max-width: 250px;
        max-height: 60px;
        overflow: hidden;
        cursor: pointer;
        position: relative;
        transition: all 0.2s ease;
    }
    .cell-content.truncated::after {
        content: '...';
        position: absolute;
        bottom: 0;
        right: 0;
        background: linear-gradient(to right, transparent, var(--ink-800) 50%);
        padding-left: 1rem;
    }
    .cell-content.expanded {
        max-width: none;
        max-height: none;
        white-space: pre-wrap;
        word-break: break-word;
    }
    .cell-content:hover {
        background: var(--ink-600);
        border-radius: 4px;
    }
    .expand-hint {
        font-size: 0.6875rem;
        color: var(--primary-400);
        margin-top: 0.25rem;
        opacity: 0;
        transition: opacity 0.2s;
    }
    .cell-content:hover .expand-hint {
        opacity: 1;
    }
    /* Row detail view */
    .row-detail {
        display: none;
        background: var(--ink-750);
        padding: 1rem;
        border-bottom: 1px solid var(--ink-600);
    }
    .row-detail.visible {
        display: table-row;
    }
    .row-detail-content {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 1rem;
    }
    .row-detail-field {
        background: var(--ink-800);
        border-radius: 6px;
        padding: 0.75rem;
    }
    .row-detail-label {
        font-size: 0.6875rem;
        font-weight: 600;
        color: var(--turquoise-400);
        text-transform: uppercase;
        margin-bottom: 0.5rem;
    }
    .row-detail-value {
        font-size: 0.8125rem;
        color: var(--sand-200);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 200px;
        overflow-y: auto;
    }
    """)

    def render_sample_data_table(
        sample_data: list, field_names: list, dataset_idx: int
    ):
        """Render a table showing sample datapoints with expand functionality."""
        if not sample_data:
            return None

        # Build table rows with expandable detail rows
        rows = []
        for idx, row_data in enumerate(sample_data, 1):
            if isinstance(row_data, dict):
                row_id = f"ds{dataset_idx}-row{idx}"

                # Main row with truncated preview
                cells = [
                    Td(
                        str(idx),
                        cls="row-num",
                        onclick=f"toggleRowDetail('{row_id}')",
                        style="cursor: pointer",
                    )
                ]
                for field in field_names:
                    value = row_data.get(field, "")
                    str_value = str(value) if value else ""
                    is_long = len(str_value) > 60

                    cell_content = Div(
                        cls=f"cell-content {'truncated' if is_long else ''}",
                        onclick=f"toggleRowDetail('{row_id}')",
                    )(
                        str_value[:60] if is_long else str_value,
                    )
                    cells.append(Td(cell_content))

                rows.append(Tr(*cells, id=f"{row_id}-main", cls="data-row"))

                # Detail row (hidden by default)
                detail_fields = []
                for field in field_names:
                    value = row_data.get(field, "")
                    str_value = str(value) if value else "(empty)"
                    detail_fields.append(
                        Div(cls="row-detail-field")(
                            Div(field, cls="row-detail-label"),
                            Div(str_value, cls="row-detail-value"),
                        )
                    )

                detail_row = Tr(
                    Td(
                        Div(cls="row-detail-content")(*detail_fields),
                        colspan=str(len(field_names) + 1),
                    ),
                    id=f"{row_id}-detail",
                    cls="row-detail",
                )
                rows.append(detail_row)

        if not rows:
            return None

        # Build header
        header_cells = [Th("#", style="cursor: default")]
        for field in field_names:
            header_cells.append(Th(field))

        # JavaScript for row expansion
        expand_script = Script("""
            function toggleRowDetail(rowId) {
                const detailRow = document.getElementById(rowId + '-detail');
                if (detailRow) {
                    detailRow.classList.toggle('visible');
                }
            }
        """)

        return Div(
            Div(
                cls="datapoints-table-container",
                style="max-height: 400px; overflow-y: auto",
            )(
                Table(cls="datapoints-table")(
                    Thead(Tr(*header_cells)),
                    Tbody(*rows),
                ),
            ),
            Div(
                "Click any row to expand and see full content",
                style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem; text-align: center",
            ),
            expand_script,
        )

    dataset_cards = []
    for i, ds in enumerate(datasets):
        name = ds.get("name", f"Dataset {i + 1}")
        description = ds.get("description", "")
        fields = ds.get("fields", [])
        sample_data = ds.get("sample_data", [])

        # Get matched prompt name (1:1 matching by index)
        matched_prompt_name = None
        if i < len(prompts):
            matched_prompt_name = prompts[i].get("name", f"Prompt {i + 1}")

        # Extract field names
        field_names = [
            f.get("name", "unknown") if isinstance(f, dict) else str(f) for f in fields
        ]

        # Render sample data table with dataset index for unique IDs
        sample_table = render_sample_data_table(sample_data, field_names, i)

        dataset_cards.append(
            Div(cls="dataset-card")(
                Div(cls="dataset-header")(
                    Span(cls="dataset-name")(
                        Span("📊", cls="dataset-icon"),
                        Span(name),
                    ),
                    Div(cls="dataset-meta")(
                        Span(f"{len(field_names)} fields"),
                        Span(f"{len(sample_data)} datapoints") if sample_data else None,
                    ),
                ),
                Div(cls="dataset-body")(
                    Div(cls="dataset-section")(
                        Div("Description", cls="dataset-section-label"),
                        P(description, style="color: var(--sand-200); margin: 0"),
                    )
                    if description
                    else None,
                    Div(cls="dataset-section")(
                        Div("Linked Prompt", cls="dataset-section-label"),
                        Div(
                            f"Uses system prompt from: {matched_prompt_name}",
                            cls="dataset-system-prompt",
                            style="font-style: italic; color: var(--primary-orange);",
                        ),
                    )
                    if matched_prompt_name
                    else None,
                    Div(cls="dataset-section")(
                        Div("Fields", cls="dataset-section-label"),
                        Div(cls="dataset-fields")(
                            *[Span(f, cls="dataset-field-tag") for f in field_names]
                        ),
                    )
                    if field_names
                    else None,
                    Div(cls="dataset-section")(
                        Div("Sample Datapoints", cls="dataset-section-label"),
                        sample_table,
                    )
                    if sample_table
                    else None,
                ),
            )
        )

    return Div(
        dataset_styles,
        Div(cls="card")(
            Div("Review Your Datasets", cls="card-title"),
            P(
                "These datasets will be created in your workspace. Review them before proceeding.",
                style="color: var(--ink-400); margin-bottom: 1.5rem",
            ),
            *dataset_cards,
            Div(cls="btn-group", style="justify-content: center; margin-top: 1.5rem")(
                Button(
                    "Confirm",
                    hx_post="/approve-datasets",
                    hx_target="#main-content",
                    cls="btn btn-success",
                ),
                Button(
                    "Regenerate Datasets",
                    hx_post="/regenerate-datasets",
                    hx_target="#main-content",
                    cls="btn btn-secondary",
                ),
                Button(
                    "Cancel",
                    hx_post="/cancel",
                    hx_target="#main-content",
                    cls="btn btn-danger",
                ),
            ),
        ),
    )


def render_plan_preview(plan: Dict[str, Any]):
    """Render the plan preview with approval buttons."""
    datasets = plan.get("datasets", [])
    prompts = plan.get("prompts", [])

    return Div(
        # Reasoning
        Div(cls="card")(
            Div("Plan Summary", cls="card-title"),
            P(
                plan.get("reasoning", "Your workspace plan is ready for review."),
                style="color: var(--sand-100); line-height: 1.6",
            ),
        )
        if plan.get("reasoning")
        else None,
        # Datasets
        Div(cls="card")(
            Div(cls="plan-section")(
                Div(cls="plan-section-title")(
                    Span("📊"),
                    Span(f"Datasets ({len(datasets)})"),
                ),
                *[
                    _render_plan_item(f"Dataset {i}", d)
                    for i, d in enumerate(datasets, 1)
                ],
            )
            if datasets
            else Div("No datasets in plan", style="color: var(--ink-400)"),
        ),
        # Prompts
        Div(cls="card")(
            Div(cls="plan-section")(
                Div(cls="plan-section-title")(
                    Span("✏️"),
                    Span(f"Prompts ({len(prompts)})"),
                ),
                *[
                    _render_plan_item(f"Prompt {i}", p)
                    for i, p in enumerate(prompts, 1)
                ],
            )
            if prompts
            else Div("No prompts in plan", style="color: var(--ink-400)"),
        ),
        # Action Buttons
        Div(cls="btn-group", style="justify-content: center")(
            Button(
                "Create Now",
                hx_post="/execute",
                hx_target="#main-content",
                cls="btn btn-success",
            ),
            Button(
                "Regenerate",
                hx_post="/regenerate",
                hx_target="#main-content",
                cls="btn btn-secondary",
            ),
            Button(
                "Cancel",
                hx_post="/cancel",
                hx_target="#main-content",
                cls="btn btn-danger",
            ),
        ),
    )


def _render_plan_item(title: str, item: Dict[str, Any]):
    """Render a single plan item (dataset or prompt)."""
    name = item.get("name", "Unnamed")
    description = item.get("description", "No description")
    system_prompt = item.get("system_prompt", "")

    return Details(cls="plan-item", open=False)(
        Summary(cls="plan-item-header")(
            Span(f"{title}: {name}", cls="plan-item-name"),
        ),
        Div(cls="plan-item-content")(
            P(Strong("Description: "), description),
            # Show fields for datasets
            Div(
                Strong("Fields: "),
                ", ".join([f.get("name", "?") for f in item.get("fields", [])]),
            )
            if item.get("fields")
            else None,
            # Show model for prompts
            Div(
                Strong("Model: "),
                item.get("model", "gpt-4o-mini"),
            )
            if "model" in item
            else None,
            # Show system prompt (for both datasets and prompts)
            Div(
                Strong("System Prompt:"),
                Pre(system_prompt),
            )
            if system_prompt
            else None,
        ),
    )


def render_executing_state():
    """Render the executing state - persisting to SDK."""
    return Div(
        hx_ext="sse",
        sse_connect="/stream/executing",
        sse_swap="message",
        hx_target="#execute-updates",
    )(
        Div(cls="card")(
            Div("Saving to Workspace", cls="card-title"),
            render_progress_stepper(EXECUTION_STEPS, "execute"),
            # Progress bar for persistence (shown during SDK writes)
            Div(
                id="datapoint-progress",
                cls="progress-bar-container",
                style="display: none",
            )(
                Div(cls="progress-bar-label")(
                    Span("Saving resources...", cls="progress-bar-text"),
                    Span("0 / 0", id="progress-bar-count", cls="progress-bar-count"),
                ),
                Div(cls="progress-bar-track")(
                    Div(id="progress-bar-fill", cls="progress-bar-fill"),
                ),
                Div(id="progress-bar-detail", cls="progress-bar-detail"),
            ),
            Div(id="execute-updates", style="display: none"),
        ),
    )


def render_results(result: Dict[str, Any], form_data: Optional[Dict[str, Any]] = None):
    """Render the success results.

    Args:
        result: The result dict containing datasets_created, prompts_created, errors
        form_data: Optional form configuration to display setup summary
    """
    datasets_created = result.get("datasets_created", [])
    prompts_created = result.get("prompts_created", [])
    errors = result.get("errors", [])

    # Build configuration summary if form_data provided
    config_summary = None
    if form_data:
        config_summary = Div(cls="card")(
            Div("Configuration Summary", cls="card-title"),
            Div(cls="config-summary")(
                Div(cls="config-item")(
                    Div("Company Type", cls="config-item-label"),
                    Div(form_data.get("company_type", "N/A"), cls="config-item-value"),
                ),
                Div(cls="config-item")(
                    Div("Industry", cls="config-item-label"),
                    Div(form_data.get("industry", "N/A"), cls="config-item-value"),
                ),
                Div(cls="config-item")(
                    Div("Model", cls="config-item-label"),
                    Div(form_data.get("model", "N/A"), cls="config-item-value"),
                ),
            ),
        )

    # Build dataset items with descriptions
    dataset_items = []
    for d in datasets_created:
        description = getattr(d, "description", "") if hasattr(d, "description") else ""
        dataset_items.append(
            Div(cls="result-item")(
                Div(cls="result-item-header")(
                    Span("✓", cls="result-item-icon"),
                    Span(
                        f"Dataset: {d.name}",
                        style="color: var(--sand-100); font-weight: 500",
                    ),
                ),
                Div(description, cls="result-item-description")
                if description
                else None,
                Div(f"ID: {d.id}", cls="result-item-id"),
            )
        )

    # Build prompt items with descriptions
    prompt_items = []
    for p in prompts_created:
        description = getattr(p, "description", "") if hasattr(p, "description") else ""
        prompt_items.append(
            Div(cls="result-item")(
                Div(cls="result-item-header")(
                    Span("✓", cls="result-item-icon"),
                    Span(
                        f"Prompt: {p.name}",
                        style="color: var(--sand-100); font-weight: 500",
                    ),
                ),
                Div(description, cls="result-item-description")
                if description
                else None,
                Div(f"ID: {p.id}", cls="result-item-id"),
            )
        )

    return Div(
        # Success Header
        Div(cls="result-card")(
            Div(style="text-align: center; margin-bottom: 1.5rem")(
                Div("🎉", style="font-size: 3rem; margin-bottom: 0.5rem"),
                H2("Workspace Created!", style="color: var(--sand-100); margin: 0"),
            ),
            Div(style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem")(
                Div(cls="result-metric")(
                    Div(str(len(datasets_created)), cls="result-metric-value"),
                    Div("Datasets Created", cls="result-metric-label"),
                ),
                Div(cls="result-metric")(
                    Div(str(len(prompts_created)), cls="result-metric-value"),
                    Div("Prompts Created", cls="result-metric-label"),
                ),
            ),
        ),
        # Configuration Summary
        config_summary,
        # Created Items
        Div(cls="card")(
            Div("Created Resources", cls="card-title"),
            *dataset_items,
            *prompt_items,
        )
        if dataset_items or prompt_items
        else None,
        # Errors
        Div(cls="error-box")(
            H3("Errors", style="color: var(--error-400); margin-top: 0"),
            *[P(e) for e in errors],
        )
        if errors
        else None,
        # Start Over Button
        Div(style="text-align: center; margin-top: 2rem")(
            Button(
                "Start New Setup",
                hx_post="/reset",
                hx_target="#main-content",
                cls="btn btn-primary",
            ),
        ),
    )


def render_error(error: str):
    """Render error state."""
    return Div(
        Div(cls="error-box")(
            H2("Something went wrong", style="color: var(--error-400); margin-top: 0"),
            P(error, style="margin-bottom: 1.5rem"),
            Button(
                "Try Again",
                hx_post="/reset",
                hx_target="#main-content",
                cls="btn btn-secondary",
            ),
        ),
    )


def render_human_input(question: str, reasoning: str = None):
    """Render the human input form."""
    return Div(
        Div(cls="card")(
            Div("Input Required", cls="card-title"),
            P(
                reasoning or "The agent needs more information to proceed.",
                style="color: var(--ink-400); margin-bottom: 1rem",
            )
            if reasoning
            else None,
            Div(
                style="background: var(--ink-700); padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem"
            )(
                P(
                    question or "Please provide additional information.",
                    style="color: var(--sand-100); margin: 0",
                ),
            ),
            Form(hx_post="/submit-response", hx_target="#main-content")(
                Div(cls="form-group")(
                    Textarea(
                        name="response",
                        placeholder="Type your response...",
                        cls="form-input",
                        rows="4",
                        required=True,
                    ),
                ),
                Div(cls="btn-group")(
                    Button("Submit Response", type="submit", cls="btn btn-success"),
                    Button(
                        "Cancel",
                        hx_post="/cancel",
                        hx_target="#main-content",
                        cls="btn btn-danger",
                    ),
                ),
            ),
        ),
    )
