"""ORQ platform-agent evaluatorq job utilities."""

from __future__ import annotations


def _sanitize_job_name(value: str) -> str:
    """Sanitize a value for use in job names (alphanumeric, dash, underscore)."""
    return ''.join(ch if ch.isalnum() or ch in {'-', '_'} else '-' for ch in value).strip('-') or 'unknown'
