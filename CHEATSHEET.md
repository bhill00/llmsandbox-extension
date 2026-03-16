# UCSB LLM Sandbox — What Developers Need to Know

## What It Is (and Isn't)

LLM Sandbox is a **privacy-by-design** deployment of LLMs via AWS Bedrock, designed to meet NIST 800-171 compliance requirements. It gives you access to Claude, Amazon Nova, and other Bedrock models without data leaving UCSB's controlled environment.

**It is not** a drop-in replacement for the Anthropic API, OpenAI API, or any standard cloud LLM workflow. The architecture is fundamentally different and imposes constraints you need to design around.

**Note:** The API endpoint's compliance does not automatically extend to tools that consume it. If you're working with controlled data (CUI, ITAR, FERPA), consult your security/compliance team before using any third-party tools with the Sandbox.

## The Two Big Differences

### 1. The model is stateless — it has no memory

All LLM APIs are stateless — no API remembers previous calls. The difference is how they accept input. Anthropic and OpenAI APIs accept a structured messages[] array where each turn is tagged with a role (system/user/assistant), and the model processes them as distinct conversation turns. The client still manages and sends the full history every time, but the model sees proper structure.

The LLM Sandbox Bot API accepts only a single text message. There is no messages array. You must flatten your history into one text blob, which loses the structured role boundaries.

The API does maintain conversation records in DynamoDB (message IDs, threading), but it does not automatically prepend prior messages to your request.

What this means for you:
- If you want multi-turn conversation, YOU must maintain a history and prepend it to every message
- The chat UI in LLM Sandbox handles this via DynamoDB — it reconstructs context from stored messages before each call. It is not using the structured messages[] format that Anthropic's API supports.
- If you're building your own bot/tool, you need to implement this yourself

The pattern: Your message to the API = prior context you assembled + the actual new message

Store the original user input in your history, not the full context-stuffed payload. If you store the full message (which already includes prior context), the next turn prepends that doubled context again and it compounds exponentially.

### 2. The API is async — no streaming, no immediate responses

POST returns a message ID. You poll a GET endpoint until the response shows up as a child of that message. There are no webhooks, no streaming, no server-sent events. Plan your UX around a loading spinner, not a typing indicator.

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

There are also server-side infrastructure limits — API Gateway has a 10MB payload limit, DynamoDB items cap at 400KB. Long conversations with large code blocks may cause slow responses or errors.

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
- You need the standard Anthropic/OpenAI messages API (not compatible)
- You're building something that depends on structured messages[] input, function calling, or tool use
- You need low-latency, high-throughput production workloads
- Your data has no compliance requirements and a commercial API would be simpler

## Quick API Reference

Auth: x-api-key header
Send: POST {API_URL}/conversation
Poll: GET {API_URL}/conversation/{conversation_id} → messageMap[server_message_id].children[0] is your reply
Thread: Use the server-returned messageId (ULID) as parent_message_id in your next call
Models: Check with your sandbox administrator. Common ones include Claude (claude-v4.5-sonnet, claude-v4-sonnet, claude-v3.5-sonnet) and Amazon Nova.

## Next Steps: Local LLM Orchestration

The token cost problem suggests a natural improvement: a local small LLM (Qwen, Llama, Mistral via Ollama) that handles the routine work — context management, summarization, RAG retrieval, routing simple questions — and only defers to the Sandbox for tasks requiring full Claude-level reasoning. This could dramatically reduce token burn.

But NIST 800-171 compliance applies to the entire data pipeline, not just the final API call. If you're working with CUI, the orchestration layer must meet the same requirements. Key questions:

- Where does the local model run? A personal laptop may not qualify. A university-managed system with FDE and proper access controls may.
- Where is context stored? In-memory session state is different from persisting to disk. Written controlled data needs compliant storage.
- What does the local model see? If it processes CUI, its runtime is in scope. If it only sees metadata (turn counts, topic labels), the exposure is different.
- Vector stores (ChromaDB etc.) with embeddings of controlled data are likely in scope.

The safest approach: a metadata-only local layer that tracks conversation structure and routing decisions but never sees controlled content. The Sandbox handles all content processing. This keeps the compliance boundary clean while reducing orchestration token burn.

## Bottom Line

LLM Sandbox gives you LLM access with strong privacy guarantees. The tradeoff is that the API is lower-level than what you're used to — no conversation memory, no streaming, no prompt caching, async polling. The chat UI abstracts this away for interactive use, but if you're building bots or tools on top of it, you need to handle context management and polling yourself. Watch your token burn — long conversations get expensive fast. And if you're building a local orchestration layer, think carefully about where your compliance boundary sits before piping CUI through a local model.
