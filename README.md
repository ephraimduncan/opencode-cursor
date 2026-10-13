# opencode-cursor-oauth

OpenCode plugin that connects to Cursor's API, giving you access to Cursor
models inside OpenCode with full tool-calling support.

## OpenCode V2 beta

Install the plugin:

```sh
opencode2 plugin add opencode-cursor-oauth
```

The command adds the package to your global V2 configuration.

Start `opencode2`.
Run `/connect`.
Select Cursor.

The plugin adds Cursor OAuth and the available models to the V2 catalog.

You can also add the package directly to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-cursor-oauth"
  ]
}
```

## OpenCode V1

Add the package to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cursor-oauth"
  ]
}
```

Connect Cursor:

```sh
opencode auth login --provider cursor
```

OpenCode V1 and OpenCode V2 add the `cursor` provider and its models.
OpenCode installs npm plugins during startup.
You do not have to clone this repository.

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

### HTTP/1.1 fallback

Set `disableHttp2` in the plugin entry of `opencode.json`. OpenCode passes
the second element of a `[package, options]` tuple as the plugin options.
`CURSOR_DISABLE_HTTP2=1` still works when the option is omitted. This is
useful when the H2 bridge cannot connect (for example corporate proxies that
block HTTP/2):

```jsonc
{
  "plugin": [
    ["opencode-cursor-oauth", { "disableHttp2": true }]
  ]
}
```

A local build uses the same tuple with the file path:

```jsonc
{
  "plugin": [
    ["./dist/index.js", { "disableHttp2": true }]
  ]
}
```

Unary RPCs such as model discovery are a plain HTTP/1.1 `POST` with
`Content-Type: application/proto` and the raw protobuf body.

Agent turns use Cursor's HTTP/1.1 fallback and do stream:

- `POST /agent.v1.AgentService/RunSSE` with `Content-Type: application/connect+proto`,
  header `x-cursor-streaming: true`, and one Connect envelope whose payload is
  `BidiRequestId` (the same id as `x-request-id`).
- The run request and every later client message (tool results, KV replies,
  heartbeats) go to `POST /aiserver.v1.BidiService/BidiAppend`. The `data`
  field is the hex encoding of an `AgentClientMessage`, and `request_id`
  matches the `RunSSE` `x-request-id`. `append_seqno` starts at 0 for the run
  request and increases by one for each message.

The response is a stream of Connect envelopes. Cursor labels this response
`text/event-stream`, but the bytes are still envelopes, not `data:` events.
The proxy reads them as they arrive and emits OpenAI SSE chunks. A final
envelope with flag `0x02` ends the stream. While the turn is open the proxy
sends a client heartbeat on `BidiAppend` every 5 seconds.

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