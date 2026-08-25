# L1 — Provider Abstraction Layer

One interface, four providers, zero wire-format leakage upstream.

## The contract (what L2 consumes)

```ts
const adapter: ProviderAdapter = createProvider('openai' | 'anthropic' | 'xai' | 'deepseek', {
  apiKey?, baseUrl?, fetchImpl?, timeoutMs?, retry?
});

for await (const event of adapter.complete(request)) { ... }
// events: text_delta | tool_call_start | tool_call_delta | tool_call_end | finish{reason, usage}
```

- **Errors throw, not stream.** Failures surface as `ProviderError` out of the iterator:
  - `kind`: `transport_retryable | rate_limited | schema_violation | fatal`
  - `retryable`: true only for the first two (retry loop uses this)
  - `providerFault`: `true` = infrastructure/model-output side → the Arbiter (L3) may EXCLUDE these from agent scoring; `false` = caller-side config/request bug.
- **Tool calls arrive parsed**: `tool_call_end.call.arguments` is a JSON object. Unparseable model output throws `schema_violation` tagged `providerFault=true`.
- **Exactly one** `finish` event on success; usage rides on it (`inputTokens/outputTokens`).
- Cost estimation: `estimateCost(provider, model, usage)` — returns `undefined` for unknown models, never guesses.

## Deliberate boundary: what retry does NOT cover

Transport retries (with jitter + Retry-After honoring) wrap everything up to **response headers**. Once SSE headers arrive we never replay a request — a mid-stream failure would duplicate already-emitted deltas. Mid-stream failures throw; the Agent Core (L2) decides whether to resume.

## Dialect handling notes

| Concern | OpenAI / xAI / DeepSeek | Anthropic |
|---|---|---|
| Endpoint | `/v1/chat/completions` (Bearer) | `/v1/messages` (x-api-key + anthropic-version) |
| System prompt | system-role message | top-level `system` param |
| Tool results | role `tool` messages | user-role `tool_result` blocks |
| Role alternation | free | enforced → consecutive same-role merged |
| History opening | any role | must open with user → synthetic marker prepended |
| Usage in stream | `stream_options.include_usage` | message_start + message_delta events |

xAI and DeepSeek reuse the `OpenAICompatibleAdapter` base; DeepSeek additionally strips `temperature` for reasoner models (known-rejected param).

Known simplification (documented debt): DeepSeek reasoning content is dropped, not normalized. Add a reasoning channel to `StreamEvent` if/when L2 needs it.
