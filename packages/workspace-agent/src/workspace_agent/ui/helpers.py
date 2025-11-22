"""Simplified UI helpers for Streamlit app."""

import streamlit as st
from typing import Dict, Any, List

from ..log import logger


# Default configuration
DEFAULT_WORKSPACE_KEY = "orq-research"
DEFAULT_PROJECT_PATH = "WorkspaceAgent"
DEFAULT_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJvcnEuYWkiLCJ3b3Jrc3BhY2VfaWQiOiI2MjRjY2JiZC1hNDgyLTQwZTItYjNkOS0zNjIxZTA5ZGExZjgiLCJwcm9qZWN0cyI6WyIwMTlhYTgyZS0wZmFjLTcwMDAtOTk0MS02NmZiNGZjNzMyNTQiXSwiaWF0IjoxNzYzNzU4MjI5fQ.BAMNYIE9xBKTZV7hGQoKA6FCT4dIOso-SDrf7jbg6TM"

# Industry presets for quick setup
PRESETS = {
    "E-commerce (Fashion)": {
        "company_type": "E-commerce",
        "industry": "Fashion Retail",
        "instructions": "Focus on customer support, product recommendations, and order tracking.",
    },
    "SaaS (B2B)": {
        "company_type": "SaaS",
        "industry": "B2B Software",
        "instructions": "Focus on onboarding, feature explanations, and technical support.",
    },
    "Healthcare": {
        "company_type": "Healthcare",
        "industry": "Telehealth",
        "instructions": "Focus on appointment scheduling, symptom assessment, and patient FAQs.",
    },
    "Custom": {
        "company_type": "",
        "industry": "",
        "instructions": "",
    },
}


def render_sidebar_form() -> Dict[str, Any] | None:
    """Render the sidebar form and return form data if submitted."""
    with st.sidebar:
        st.header("Workspace Setup")

        # Preset selector
        preset = st.selectbox("Quick Preset", list(PRESETS.keys()))
        preset_data = PRESETS[preset]

        # Form inputs
        with st.form("setup_form"):
            company_type = st.text_input(
                "Company Type",
                value=preset_data["company_type"],
                placeholder="e.g., E-commerce, SaaS, Healthcare",
            )

            industry = st.text_input(
                "Industry",
                value=preset_data["industry"],
                placeholder="e.g., Fashion Retail, Fintech",
            )

            instructions = st.text_area(
                "Specific Instructions",
                value=preset_data["instructions"],
                placeholder="Any specific requirements...",
                height=100,
            )

            st.divider()

            # API Keys
            workspace_key = st.text_input(
                "Workspace Key (UUID)",
                value=DEFAULT_WORKSPACE_KEY,
                type="default",
                help="Your workspace UUID",
            )

            customer_api_key = st.text_input(
                "Customer API Key",
                value=DEFAULT_API_KEY,
                type="password",
                help="JWT token starting with 'ey'",
            )

            st.divider()

            # Options
            col1, col2 = st.columns(2)
            with col1:
                num_rows = st.number_input(
                    "Dataset Rows",
                    min_value=1,
                    max_value=20,
                    value=5,
                )
            with col2:
                project_path = st.text_input(
                    "Project Path",
                    value=DEFAULT_PROJECT_PATH,
                )

            model = st.selectbox(
                "Model",
                ["google/gemini-2.5-flash"],
                help="Model for agent operations",
            )

            dry_run = st.checkbox("Dry Run (Plan Only)", value=True)

            submitted = st.form_submit_button("🚀 Start Setup", use_container_width=True)

            if submitted:
                # Validate
                errors = []
                if not company_type:
                    errors.append("Company Type is required")
                if not industry:
                    errors.append("Industry is required")
                if not workspace_key:
                    errors.append("Workspace Key is required")
                if not customer_api_key:
                    errors.append("Customer API Key is required")
                elif not customer_api_key.startswith("ey"):
                    errors.append("API Key should be a JWT (starts with 'ey')")

                if errors:
                    for error in errors:
                        st.error(f"❌ {error}")
                    logger.warning(f"Form validation failed: {errors}")
                    return None

                logger.info(f"Form submitted: {company_type} / {industry}, dry_run={dry_run}")

                return {
                    "company_type": company_type,
                    "industry": industry,
                    "instructions": instructions,
                    "workspace_key": workspace_key,
                    "customer_api_key": customer_api_key,
                    "num_rows": num_rows,
                    "project_path": project_path,
                    "model": model,
                    "dry_run": dry_run,
                }

    return None


def render_plan_preview(plan: Dict[str, Any]):
    """Render workspace plan with clear visual layout by category."""
    st.header("📋 Workspace Plan")

    # Reasoning
    if plan.get("reasoning"):
        st.info(f"**Reasoning:** {plan['reasoning']}")

    # Datasets section
    st.subheader("📊 Datasets")
    datasets = plan.get("datasets", [])
    if datasets:
        for i, dataset in enumerate(datasets, 1):
            with st.expander(f"Dataset {i}: {dataset.get('name', 'Unnamed')}", expanded=True):
                st.write(f"**Description:** {dataset.get('description', 'No description')}")

                # System prompt for all datapoints
                system_prompt = dataset.get("system_prompt", "")
                if system_prompt:
                    st.write("**System Prompt** (for all datapoints):")
                    st.code(system_prompt, language=None)

                # Fields
                fields = dataset.get("fields", [])
                if fields:
                    st.write("**Fields:**")
                    for field in fields:
                        field_name = field.get("name", "unknown")
                        field_type = field.get("type", "string")
                        field_desc = field.get("description", "")
                        st.write(f"  - `{field_name}` ({field_type}): {field_desc}")

                # Sample data
                sample_data = dataset.get("sample_data", [])
                if sample_data:
                    st.write(f"**Sample Data:** ({len(sample_data)} rows)")
                    st.json(sample_data[:3])  # Show first 3 rows
    else:
        st.warning("No datasets in plan")

    # Prompts section
    st.subheader("✏️ Prompts")
    prompts = plan.get("prompts", [])
    if prompts:
        for i, prompt in enumerate(prompts, 1):
            with st.expander(f"Prompt {i}: {prompt.get('name', 'Unnamed')}", expanded=True):
                st.write(f"**Description:** {prompt.get('description', 'No description')}")
                st.write(f"**Model:** {prompt.get('model', 'gpt-4o-mini')}")
                st.write(f"**Temperature:** {prompt.get('temperature', 0.7)}")

                # System prompt
                system_prompt = prompt.get("system_prompt", "")
                if system_prompt:
                    st.write("**System Prompt:**")
                    st.code(system_prompt, language=None)
    else:
        st.warning("No prompts in plan")

    logger.debug(f"Rendered plan preview: {len(datasets)} datasets, {len(prompts)} prompts")


def render_results(result: Dict[str, Any]):
    """Render final results after execution."""
    st.header("✅ Setup Complete")

    col1, col2 = st.columns(2)

    with col1:
        st.metric("Datasets Created", len(result.get("datasets_created", [])))
        for dataset in result.get("datasets_created", []):
            st.success(f"📊 {dataset.name} (ID: {dataset.id})")

    with col2:
        st.metric("Prompts Created", len(result.get("prompts_created", [])))
        for prompt in result.get("prompts_created", []):
            st.success(f"✏️ {prompt.name} (ID: {prompt.id})")

    # Errors
    errors = result.get("errors", [])
    if errors:
        st.subheader("⚠️ Errors")
        for error in errors:
            st.error(error)

    logger.info(f"Results displayed: {len(result.get('datasets_created', []))} datasets, {len(result.get('prompts_created', []))} prompts")


def render_error(error: str):
    """Render error message."""
    st.error(f"❌ {error}")
    logger.error(f"Displayed error: {error}")
