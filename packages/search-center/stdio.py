"""Expose the same Magpie plugin tools to clients that require stdio."""
import os

from fastmcp.server import create_proxy


if __name__ == "__main__":
    create_proxy(
        os.environ.get('SEARCH_CENTER_MCP_URL', 'http://127.0.0.1:3425/mcp/magpie/tools/magpie-search-center'),
        name="search",
    ).run(transport="stdio", show_banner=False)
