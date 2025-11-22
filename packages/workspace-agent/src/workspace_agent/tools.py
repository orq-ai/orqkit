"""
MCP client management for workspace setup.

Supports both TypeScript (orq_mcp_ts) and Python (orq-mcp) MCP servers.
Set MCP_SERVER to switch between implementations.
"""

import asyncio
import json
import os
from pathlib import Path
from typing import Any
from langchain_mcp_adapters.client import MultiServerMCPClient

# JSON Schema fields not supported by Gemini
UNSUPPORTED_SCHEMA_FIELDS = {
    "exclusiveMinimum",
    "exclusiveMaximum",
    "$schema",
    "$id",
    "$ref",
    "$defs",
    "definitions",
    "contentMediaType",
    "contentEncoding",
    "if",
    "then",
    "else",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "contains",
    "additionalItems",
    "unevaluatedItems",
    "unevaluatedProperties",
    "dependentRequired",
    "dependentSchemas",
    "propertyNames",
    "patternProperties",
}


def _sanitize_schema(schema: Any) -> Any:
    """Recursively sanitize JSON schema by removing unsupported fields for Gemini."""
    if isinstance(schema, dict):
        sanitized = {}
        for key, value in schema.items():
            if key not in UNSUPPORTED_SCHEMA_FIELDS:
                sanitized[key] = _sanitize_schema(value)
        return sanitized
    elif isinstance(schema, list):
        return [_sanitize_schema(item) for item in schema]
    return schema


def _sanitize_tool(tool) -> Any:
    """Sanitize a LangChain tool's args_schema for Gemini compatibility."""
    # Try to access and sanitize the tool's schema
    if hasattr(tool, 'args_schema') and tool.args_schema:
        try:
            # Get the schema as dict
            if hasattr(tool.args_schema, 'model_json_schema'):
                original_schema = tool.args_schema.model_json_schema()
                sanitized = _sanitize_schema(original_schema)
                # Patch the schema method to return sanitized version
                tool.args_schema.model_json_schema = lambda s=sanitized: s
        except Exception:
            pass
    return tool

# Choose MCP server implementation: "typescript" or "python"
MCP_SERVER = os.environ.get("MCP_SERVER", "typescript")

# Global MCP client instance
_mcp_client = None


def _get_typescript_config(customer_api_key: str) -> dict:
    """Get MCP client config for TypeScript server (orq_mcp_ts)."""
    current_dir = Path(__file__).parent
    orq_mcp_ts_dir = current_dir.parent.parent.parent / "orq_mcp_ts"

    # Use bun to run the compiled TypeScript server
    bun_path = os.environ.get("BUN_PATH", os.path.expanduser("~/.bun/bin/bun"))

    return {
        "orq": {
            "command": bun_path,
            "args": ["dist/index.js"],
            "cwd": str(orq_mcp_ts_dir),
            "transport": "stdio",
            "env": {"ORQ_API_KEY": customer_api_key},
        }
    }


# def _get_python_config(customer_api_key: str) -> dict:
#     """Get MCP client config for Python server (orq-mcp)."""
#     current_dir = Path(__file__).parent
#     orq_mcp_script = (
#         current_dir.parent.parent.parent / "orq-mcp" / "scripts" / "run_mcp_server.py"
#     )
#     orq_mcp_python = (
#         current_dir.parent.parent.parent / "orq-mcp" / ".venv" / "bin" / "python"
#     )
#
#     return {
#         "orq": {
#             "command": str(orq_mcp_python),
#             "args": [str(orq_mcp_script)],
#             "transport": "stdio",
#             "env": {"ORQ_API_KEY": customer_api_key},
#         }
#     }


async def initialize_mcp_client(customer_api_key: str) -> MultiServerMCPClient:
    """Initialize MCP client with customer API key.

    Uses TypeScript server by default. Set MCP_SERVER=python to use Python server.
    """
    global _mcp_client

    if _mcp_client:
        await cleanup_mcp_client()

    # Get config based on MCP_SERVER setting
    if MCP_SERVER == "typescript":
        config = _get_typescript_config(customer_api_key)
    # elif MCP_SERVER == "python":
    #     config = _get_python_config(customer_api_key)
    else:
        raise ValueError(f"Unknown MCP_SERVER value: {MCP_SERVER}. Use 'typescript' or 'python'.")

    print(f"[MCP] Using {MCP_SERVER} server")
    print(json.dumps(config, indent=2))

    _mcp_client = MultiServerMCPClient(config)
    return _mcp_client


async def get_mcp_tools():
    """Get all MCP tools from the MCP server.

    Tools are sanitized to remove JSON schema fields not supported by Gemini.
    """
    if not _mcp_client:
        raise RuntimeError(
            "MCP client not initialized. Call initialize_mcp_client() first."
        )

    tools = await _mcp_client.get_tools()

    # Sanitize tools for Gemini compatibility
    return [_sanitize_tool(tool) for tool in tools]


async def cleanup_mcp_client():
    """Cleanup MCP client."""
    global _mcp_client
    if _mcp_client:
        try:
            await _mcp_client.cleanup()
        except:
            pass
        _mcp_client = None


if __name__ == "__main__":
    async def test():
        await initialize_mcp_client("test-key")
        tools = await get_mcp_tools()
        print(f"Loaded {len(tools)} tools:")
        for tool in tools:
            print(f"  - {tool.name}: {tool.description[:50]}...")
        await cleanup_mcp_client()

    asyncio.run(test())
