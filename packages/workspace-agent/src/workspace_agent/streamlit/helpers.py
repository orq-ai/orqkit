"""UI helpers for Streamlit app."""

import streamlit as st
from typing import Dict, Any

from ..log import logger
from ..shared import PRESETS, DEFAULT_WORKSPACE_KEY, DEFAULT_PROJECT_PATH, DEFAULT_API_KEY
from ..shared.presets import AVAILABLE_MODELS


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

            col3, col4 = st.columns(2)
            with col3:
                num_datasets = st.number_input(
                    "Number of Datasets",
                    min_value=1,
                    max_value=5,
                    value=2,
                    help="Number of datasets to create",
                )
            with col4:
                num_prompts = st.number_input(
                    "Number of Prompts",
                    min_value=1,
                    max_value=5,
                    value=2,
                    help="Number of prompts to create",
                )

            model = st.selectbox(
                "Model",
                AVAILABLE_MODELS,
                help="Model for agent operations",
            )

            submitted = st.form_submit_button("Start Setup", use_container_width=True)

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
                        st.error(f"Error: {error}")
                    logger.warning(f"Form validation failed: {errors}")
                    return None

                logger.info(f"Form submitted: {company_type} / {industry}")

                return {
                    "company_type": company_type,
                    "industry": industry,
                    "instructions": instructions,
                    "workspace_key": workspace_key,
                    "customer_api_key": customer_api_key,
                    "num_rows": num_rows,
                    "num_datasets": num_datasets,
                    "num_prompts": num_prompts,
                    "project_path": project_path,
                    "model": model,
                }

    return None


def render_plan_preview(plan: Dict[str, Any]):
    """Render workspace plan with clear visual layout by category."""
    st.header("Workspace Plan")

    # Reasoning
    if plan.get("reasoning"):
        st.info(f"**Reasoning:** {plan['reasoning']}")

    # Datasets section
    st.subheader("Datasets")
    datasets = plan.get("datasets", [])
    if datasets:
        for i, dataset in enumerate(datasets, 1):
            with st.expander(f"Dataset {i}: {dataset.get('name', 'Unnamed')}", expanded=True):
                st.write(f"**Description:** {dataset.get('description', 'No description')}")

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
    st.subheader("Prompts")
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

                # Template
                template = prompt.get("template", "")
                if template:
                    st.write("**Template:**")
                    st.code(template, language=None)
    else:
        st.warning("No prompts in plan")

    logger.debug(f"Rendered plan preview: {len(datasets)} datasets, {len(prompts)} prompts")


def render_results(result: Dict[str, Any]):
    """Render final results after execution."""
    st.header("Setup Complete")

    col1, col2 = st.columns(2)

    with col1:
        st.metric("Datasets Created", len(result.get("datasets_created", [])))
        for dataset in result.get("datasets_created", []):
            st.success(f"Dataset: {dataset.name} (ID: {dataset.id})")

    with col2:
        st.metric("Prompts Created", len(result.get("prompts_created", [])))
        for prompt in result.get("prompts_created", []):
            st.success(f"Prompt: {prompt.name} (ID: {prompt.id})")

    # Errors
    errors = result.get("errors", [])
    if errors:
        st.subheader("Errors")
        for error in errors:
            st.error(error)

    logger.info(f"Results displayed: {len(result.get('datasets_created', []))} datasets, {len(result.get('prompts_created', []))} prompts")


def render_error(error: str):
    """Render error message."""
    st.error(f"Error: {error}")
    logger.error(f"Displayed error: {error}")
