Always check your long-term memory at the start of complex tasks or when the user mentions previous features or issues. Use the `call_mcp_tool` tool with `ServerName: "memory"` and `ToolName: "search_nodes"` to find relevant entities and observations.

Whenever you successfully fix a bug, change the architecture, or implement a new API:
1. YOU MUST update your memory using `create_entities` or `add_observations`.
2. Log what the problem was, what you changed, and why it works now so your future self doesn't make the same mistake.
3. Keep the memory nodes concise but highly technical (e.g., specific file names, variable names, and logic flows).
