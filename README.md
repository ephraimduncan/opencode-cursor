# opencode-cursor-oauth

OpenCode plugin that connects to Cursor's API, giving you access to Cursor
models inside OpenCode with full tool-calling support.

## Install in OpenCode

Add this to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cursor-oauth"
  ]
}
```

The plugin registers the `cursor` provider and its models automatically once
you are logged in — no manual `provider` stub or model list is needed.

OpenCode installs npm plugins automatically at startup, so users do not need
to clone this repository.

## Authenticate

```sh
opencode auth login --provider cursor
```

This opens Cursor OAuth in the browser. Tokens are stored in
`~/.local/share/opencode/auth.json` and refreshed automatically.

## Use

Start OpenCode and select any Cursor model. The plugin starts a local
OpenAI-compatible proxy on demand and routes requests through Cursor's gRPC API.

## How it works

1. OAuth — browser-based login to Cursor via PKCE.
2. Model discovery — queries Cursor's gRPC API for all available models.
3. Local proxy — translates `POST /v1/chat/completions` into Cursor's
   protobuf/HTTP/2 Connect protocol.
4. Native tool routing — redirects Cursor's built-in filesystem/shell tools
   to the equivalent OpenCode tools, and exposes OpenCode's tool surface via
   Cursor MCP.

HTTP/2 transport runs through a Node child process (`h2-bridge.mjs`) because
Bun's `node:http2` support is not reliable against Cursor's API.

## Architecture

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                                    Node child process (h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                    api2.cursor.sh gRPC
                                      /agent.v1.AgentService/Run
```

### Tool call flow

```
1. Cursor model receives OpenAI tools via RequestContext (as MCP tool defs)
2. Model calls a tool:
   - native tools (readArgs, shellArgs, grepArgs, ...) with an OpenCode
     equivalent are redirected to it (read, bash, grep, glob, webfetch, write)
   - native tools without an equivalent are rejected with a typed error
   - MCP tools arrive as mcpArgs exec messages
3. Proxy emits OpenAI tool_calls SSE chunk, pauses H2 stream
4. OpenCode executes tool, sends result in follow-up request
5. Proxy resumes H2 stream with the typed native result (or mcpResult),
   streams continuation
```

### Conversation state

Conversation history is rebuilt from the OpenAI messages on every request
(`rootPromptMessagesJson` + content-addressed turn blobs), and server
checkpoints are persisted to `~/.cache/opencode-cursor/conversations/` so
context survives restarts. Set `CURSOR_PROXY_DEBUG=1` to log the KV blob
handshake and exec traffic when debugging.

## Develop locally

```sh
bun install
bun run build
bun test/smoke.ts
```

## Requirements

- [OpenCode](https://opencode.ai)
- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org) >= 18 for the HTTP/2 bridge process
- Active [Cursor](https://cursor.com) subscription