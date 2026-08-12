/**
 * Manual smoke test proving the plugin runs in a plain Node runtime
 * (as used by the OpenCode Desktop sidecar), not just Bun.
 *
 * Usage: bun run build && node test/node-smoke.mjs
 * Requires a valid Cursor OAuth entry in ~/.local/share/opencode/auth.json.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import plugin from "../dist/index.js"

console.log("default export:", Object.keys(plugin), "server type:", typeof plugin.server)

const hooks = await plugin.server({
  client: { auth: { set: async () => {} } },
  project: {},
  directory: "/",
  worktree: "/",
  experimental_workspace: { register() {} },
  serverUrl: new URL("http://127.0.0.1"),
  $: null,
})

// 1. config hook (model discovery into config)
const cfg = { provider: {} }
await hooks.config(cfg)
console.log("models in config:", Object.keys(cfg.provider.cursor?.models ?? {}).length)

// 2. auth.loader (returns baseURL/apiKey/fetch — what opencode calls at request time)
const getAuth = async () => {
  const all = JSON.parse(await readFile(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"))
  return all.cursor
}
const loaded = await hooks.auth.loader(getAuth, {})
console.log("baseURL from auth.loader:", loaded?.baseURL)

if (!loaded?.baseURL) {
  console.error("FAIL: no baseURL")
  process.exit(1)
}

const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 60_000)
const res = await fetch(loaded.baseURL + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "cursor-grok-4.5-high",
    messages: [{ role: "user", content: "Reply with exactly: node-works" }],
    stream: false,
    max_tokens: 10,
  }),
  signal: controller.signal,
})
clearTimeout(timeout)
const text = await res.text()
console.log("completion status:", res.status)
console.log("body:", text.slice(0, 300))
if (res.status !== 200) process.exit(1)
console.log("PASS")
process.exit(0)
