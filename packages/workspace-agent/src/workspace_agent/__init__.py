"""
Workspace Agent: Multi-agent workspace setup system using LangGraph and MCP.
"""

from .main import WorkspaceOrchestrator
from .config import WorkspaceSetupRequest

__version__ = "0.1.0"
__all__ = ["WorkspaceOrchestrator", "WorkspaceSetupRequest"]
