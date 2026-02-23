import { FastMCP } from "fastmcp";
import { allTools } from "./tools/index.js";

const server = new FastMCP({
    name: "blueprint-mcp",
    version: "1.0.0",
});

// Cleanly register all tools in one loop
allTools.forEach((tool) => server.addTool(tool as any));

// Start the server
server.start({
    transportType: "stdio",
});

// Logging to stderr is important so it doesn't break the stdio JSON stream
console.error("Blueprint Architect MCP running on stdio");