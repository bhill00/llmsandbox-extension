# UCSB LLM Sandbox — What Developers Need to Know

## What It Is (and Isn't)

LLM Sandbox is a **privacy-by-design** deployment of LLMs via AWS Bedrock, designed to meet NIST 800-171 compliance requirements. It gives you access to Claude, Amazon Nova, and other Bedrock models without data leaving UCSB's controlled environment.

**It is not** a drop-in replacement for the Anthropic API, OpenAI API, or any standard cloud LLM workflow. The architecture is fundamentally different and imposes constraints you need to design around.

**Note:** The API endpoint's compliance does not automatically extend to tools that consume it. If you're working with controlled data (CUI, ITAR, FERPA), consult your security/compliance team before using any third-party tools with the Sandbox.

## The Two Big Differences vs. Anthropic / OpenAI APIs

### 1. No structured messages, no prompt caching

All LLM APIs are stateless — the client always manages conversation history. The difference is what the API accepts. Anthropic and OpenAI accept a structured messages[] array with role-tagged turns and support prompt caching (repeated prefixes cost up to 90% less).

The LLM Sandbox Bot API accepts a single text message per request — no messages array, no roles, no system parameter, no prompt caching. Every token is full price, every turn.

The API does have **server-side conversation memory** — if you reuse a `conversationId`, the server reconstructs prior turns automatically. You can either:

- **Send only the latest message** and let the server handle history (simpler, but you lose control over what context the model sees)
- **Manage context client-side** and send a fresh `conversationId` each call (more work, but lets you compress/prioritize context)

This extension uses client-side management for better control over token costs. If you're building a simpler tool, server-side memory works fine — see the [proxy](https://github.com/bhill00/llmsandbox-openai-proxy) for an example.

If you do manage context client-side, store the original user input in your history, not the full context-stuffed payload — otherwise context compounds exponentially.

### 2. Async responses — no streaming

POST returns a message ID. You poll a per-message GET endpoint until the response appears.

```
POST /conversation → returns messageId → poll GET /conversation/{convId}/{messageId} → reply when role is "assistant"
```

There are no webhooks, no streaming, no server-sent events. The per-message endpoint returns 404 while the reply is being generated — treat this as "not ready yet" and keep polling. Plan your UX around a loading spinner, not a typing indicator.

## Understanding Context, Tokens, and Cost

Quick terminology:
- **Context window** — the model's max capacity per request (e.g. Claude Sonnet 4.5 supports 1M tokens)
- **Context budget** — a soft limit YOU set to control when to compress older turns. This is a cost control, not a model limitation.
- **Prompt size** — the actual size of each request, including system prompt, history, and current message

## Token Cost Is the Real Constraint

On standard APIs (Anthropic, OpenAI), prompt caching reduces cost for repeated context. When you send a request with the same prefix as a prior request, the API charges up to 90% less for those cached tokens. This works because in a growing conversation, each request starts with the same content as the last one plus new stuff at the end.

The LLM Sandbox has **no prompt caching**. Every token is full price, every turn.

Because the full context is re-sent with every message, cost per turn grows as the conversation gets longer:

- Turn 1: send 500 tokens → 500 input tokens consumed
- Turn 5: send ~3,000 context + 500 new → 3,500 for that one turn
- Turn 10: send ~7,000 context + 500 new → 7,500 for that one turn
- Turn 20: send ~15,000 context + 500 new → 15,500 for that one turn

Cumulative total over 20 turns: ~100,000+ input tokens. And this only counts input — assistant responses also get added to context for subsequent turns, making it grow faster.

Once you hit your context budget cap, every subsequent turn costs ~budget-size input tokens. Keep conversations short and reset often.

There are also server-side infrastructure limits — API Gateway has a 10MB payload limit, and conversation data grows with every turn. Long conversations with large code blocks may cause slow responses or errors.

## Context Compression Strategies

**Keep recent turns only** — Simple, free, but early context is gone forever. Best for quick Q&A.

**Summarize older turns** — Good retention, but costs an extra API call and degrades through repeated compression.

**Extract key facts** — Structured bullets (files, decisions, bugs, tasks) that survive repeated compression better than prose. Best for longer sessions.

## When to Use LLM Sandbox

- Working with ITAR, CUI, FERPA, or other controlled data that can't go to commercial cloud APIs
- Need privacy guarantees — data stays within UCSB's AWS environment
- Building tools for research workflows with compliance requirements
- Want central LLM access without individual API billing

## When NOT to Use LLM Sandbox

- You need streaming responses (not supported)
- You need the standard Anthropic/OpenAI messages API (not directly compatible — but the [proxy](https://github.com/bhill00/llmsandbox-openai-proxy) bridges this gap)
- You're building something that depends on OpenAI-style structured function calling (prompt-engineered tool use does work — see the [proxy README](https://github.com/bhill00/llmsandbox-openai-proxy#a-note-on-tool-use--function-calling))
- You need low-latency, high-throughput production workloads
- Your data has no compliance requirements and a commercial API would be simpler

## Quick API Reference

**Auth:** `x-api-key` header

**Send:** `POST {API_URL}/conversation`

**Poll:** `GET {API_URL}/conversation/{conversationId}/{messageId}` → reply when `message.role` is `"assistant"`

**Server memory:** Reuse the same `conversationId` across calls and the server reconstructs history automatically. Send a fresh `conversationId` each call if you manage context client-side.

**Switch models:** Just change the `model` string in the payload.

**Available models:** claude-v4.6-opus, claude-v4.5-opus, claude-v4.5-sonnet, claude-v4.5-haiku, amazon-nova-pro, amazon-nova-lite, amazon-nova-micro, qwen3-32b. The model string is passed directly to the API.

**Content types:** The API's message content field is a list, supporting multiple content types per message:
- Text: `{"contentType": "text", "body": "..."}`
- Images: `{"contentType": "image", "mediaType": "image/png", "body": "<base64>"}`
- Documents: `{"contentType": "attachment", "fileName": "doc.pdf", "mediaType": "application/pdf", "body": "<base64>"}` — supports PDF, Word, Excel, CSV, HTML, Markdown, plain text

**Agent mode / server-side tools:** If you enable Agent mode when creating your bot, the backend can execute tools autonomously. Internet Search and Knowledge Base (RAG) are available. These execute server-side — the client just sends a normal message and gets the final answer. No special client code needed. Client-side structured tool calling (OpenAI-style `tools` array) is not supported — tools must be configured on the bot.

## Next Steps: Local LLM Orchestration

The token cost problem suggests a natural improvement: a local small LLM (Qwen, Llama, Mistral via Ollama) that handles the routine work — context management, summarization, RAG retrieval, routing simple questions — and only defers to the Sandbox for tasks requiring full Claude-level reasoning. This could dramatically reduce token burn.

But NIST 800-171 compliance applies to the entire data pipeline, not just the final API call. If you're working with CUI, the orchestration layer must meet the same requirements. Key questions:

- Where does the local model run? A personal laptop may not qualify. A university-managed system with FDE and proper access controls may.
- Where is context stored? In-memory session state is different from persisting to disk. Written controlled data needs compliant storage.
- What does the local model see? If it processes CUI, its runtime is in scope. If it only sees metadata (turn counts, topic labels), the exposure is different.
- Vector stores (ChromaDB etc.) with embeddings of controlled data are likely in scope.

The safest approach: a metadata-only local layer that tracks conversation structure and routing decisions but never sees controlled content. The Sandbox handles all content processing. This keeps the compliance boundary clean while reducing orchestration token burn.

## Bottom Line

LLM Sandbox gives you LLM access with strong privacy guarantees. The tradeoff is that the API is lower-level than what you're used to — no streaming, no prompt caching, no structured messages array, async polling. The API does have server-side conversation memory (reuse a conversationId), but no prompt caching means every token is full price every turn. If you're building tools on top of it, you need to decide between server-side memory (simpler) or client-side context management (more control). Watch your token burn — long conversations get expensive fast. The [OpenAI-compatible proxy](https://github.com/bhill00/llmsandbox-openai-proxy) can bridge the gap if you need standard API compatibility. And if you're building a local orchestration layer, think carefully about where your compliance boundary sits before piping CUI through a local model.
