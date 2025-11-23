"""Shared presets and default values for workspace agent UIs."""

# Default configuration
DEFAULT_PROJECT_PATH = "WorkspaceAgent"
DEFAULT_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJvcnEuYWkiLCJ3b3Jrc3BhY2VfaWQiOiI2MjRjY2JiZC1hNDgyLTQwZTItYjNkOS0zNjIxZTA5ZGExZjgiLCJwcm9qZWN0cyI6WyIwMTlhYTgyZS0wZmFjLTcwMDAtOTk0MS02NmZiNGZjNzMyNTQiXSwiaWF0IjoxNzYzNzU4MjI5fQ.BAMNYIE9xBKTZV7hGQoKA6FCT4dIOso-SDrf7jbg6TM"

# Available models
AVAILABLE_MODELS = [
    "google/gemini-2.5-flash",
    "openai/gpt-oss-120b",
    "moonshot/kimi-k2-instruct-0905",
    "cerebras/qwen-3-235b-thinking",
]

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
