import json
import os
from fastmcp import FastMCP
from fastmcp.server.openapi import RouteMap, MCPType
import httpx
from pathlib import Path
from dotenv import load_dotenv

root_path = Path(__file__).parents[2]
load_dotenv(dotenv_path=root_path / ".env", override=True)

# Load OpenAPI spec
json_file = root_path / "openapi.json"
spec = json.load(open(json_file))

# Get API key from environment
api_key = os.getenv("ORQ_API_KEY")
if not api_key:
    raise ValueError("ORQ_API_KEY environment variable is required")

# Create HTTP client with authentication
client = httpx.AsyncClient(
    base_url="https://my.orq.ai",
    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
)


mcp = FastMCP.from_openapi(
    client=client,
    openapi_spec=spec,
    route_maps=[
        # Dataset endpoints - include both base and sub-routes
        RouteMap(
            methods=["GET", "POST", "PATCH", "DELETE"],
            pattern=r"^/v2/datasets(/.*)?$",
            mcp_type=MCPType.TOOL,
        ),
        # Prompt endpoints - exclude version endpoints, include others
        RouteMap(
            methods=["GET", "POST", "PATCH", "DELETE"],
            pattern=r"^/v2/prompts(/(?!.*versions).*)?$",
            mcp_type=MCPType.TOOL,
        ),
        # Exclude everything else
        RouteMap(mcp_type=MCPType.EXCLUDE),
    ],
    instructions="When doing an update, include just the identifier and the fields you want to update.",
)
