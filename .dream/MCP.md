# MCP servers

Add servers under `mcpServers` in `mcp.json`, for example:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Each entry is spawned with the given `command`/`args`/`env` when the harness
starts, and its tools are exposed to the agent as `mcp__<server>__<tool>`.
The map is intentionally empty by default: a scaffold must not start processes
on its own.
