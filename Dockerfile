# vs-token-safer — container image for Glama's MCP tool-introspection / CI smoke.
#
# IMPORTANT — this is NOT the recommended runtime. vs-token-safer is a LOCAL-ONLY, zero-transmission MCP
# server: it indexes YOUR codebase through local language servers (clangd / Roslyn / tsserver / pyright)
# and returns a token-capped `file:line` list — nothing is sent anywhere. A hosted/containerized instance
# has no access to your local files or toolchains, so it cannot do the actual work; install it as a Claude
# Code plugin (see README) to run it next to your code over stdio. This image exists only so Glama (and CI)
# can BUILD the server and enumerate its tool definitions — i.e. answer `tools/list` for server-coherence
# and tool-definition-quality scoring. It opens no ports and makes no network egress.
FROM node:20-slim

WORKDIR /app/server
# Only server/ is needed to start the stdio MCP server and list tools.
COPY server/ ./

# The MCP SDK and the JS/TS/Python language servers are declared as optionalDependencies (resolved at
# runtime in a normal install); install them here so the image is self-contained and fully functional for
# introspection. (clangd / Roslyn are external toolchains, not npm — not needed to enumerate tools.)
RUN npm install --omit=dev --no-audit --no-fund

# Newline-delimited JSON-RPC over stdio (standard MCP stdio transport). No ports.
CMD ["node", "index.js"]
