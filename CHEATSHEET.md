# UCSB LLM Sandbox — What Developers Need to Know

## What It Is (and Isn't)

LLM Sandbox is a **privacy-by-design** deployment of LLMs via AWS Bedrock, built for NIST 800-171 compliance. It gives you access to Claude, Amazon Nova, and other Bedrock models without data leaving UCSB's controlled environment.

**It is not** a drop-in replacement for the Anthropic API, OpenAI API, or any standard cloud LLM workflow. The architecture is fundamentally different and imposes constraints you need to design around.

## The Two Big Differences

### 1. The API is stateless — the model has no memory

Unlike the Anthropic or OpenAI APIs where you send a messages[] array and the API handles context, the LLM Sandbox Bot API sends one message at a time to the model. The model sees only what you put in that single message.

What this means for you:
- There is no conversation history on the server side
- If you want multi-turn conversation, YOU must maintain a history and prepend it to every message
- The chat UI in LLM Sandbox handles this via DynamoDB — it reconstructs context from stored messages before each call. It is not using Anthropic's native conversation management.
- If you're building your own bot/tool, you need to implement this yourself

The pattern: Your message to the API = prior context you assembled + the actual new message

Store the original user input in your history, not the full context-stuffed payload, or your context will compound exponentially.

### 2. The API is async — no streaming, no immediate responses

POST returns a message ID. You poll a GET endpoint until the response shows up as a child of that message. There are no webhooks, no streaming, no server-sent events. Plan your UX around a loading spinner, not a typing indicator.

## Token Cost Is the Real Constraint

This is the most important thing to understand. With a standard API (Anthropic, OpenAI), prompt caching means repeated context is heavily discounted — cached tokens cost up to 90% less. The LLM Sandbox has **no prompt caching**. Every token is full price, every turn.

Because context is prepended to every message, token consumption grows quadratically:

- Turn 1: send 500 tokens → 500 input tokens consumed
- Turn 5: send ~2,500 context + 500 new → 3,000 for that one turn
- Turn 10: send ~5,000 context + 500 new → 5,500 for that one turn
- Turn 20: send ~10,000 context + 500 new → 10,500 for that one turn

Cumulative input tokens over 20 turns: ~100,000+

Once you hit your context budget cap (say 20k tokens), every subsequent turn costs ~20k input tokens regardless. A 50-turn conversation after hitting the cap burns 30 turns x 20k = 600,000 input tokens just for the second half.

Even a seemingly small conversation becomes expensive fast. Keep conversations short and reset often.

There are also hard infrastructure limits — AWS API Gateway has a 10MB payload limit, DynamoDB items cap at 400KB. The messageMap returned by GET grows with every turn. Long conversations with large code blocks will eventually hit these walls.

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
- You're building something that depends on native conversation management or tool use
- You need low-latency, high-throughput production workloads
- Your data has no compliance requirements and a commercial API would be simpler

## Quick API Reference

Auth: x-api-key header
Send: POST {API_URL}/conversation
Poll: GET {API_URL}/conversation/{conversation_id} → messageMap[server_message_id].children[0] is your reply
Thread: Use the server-returned messageId (ULID) as parent_message_id in your next call
Models: Claude (claude-v4.5-sonnet, claude-v4-sonnet, claude-v3.5-sonnet), Amazon Nova, and other Bedrock models

## Bottom Line

LLM Sandbox gives you LLM access with strong privacy guarantees. The tradeoff is that the API is lower-level than what you're used to — no conversation memory, no streaming, no prompt caching, async polling. The chat UI abstracts this away for interactive use, but if you're building bots or tools on top of it, you need to handle context management and polling yourself. And watch your token burn — long conversations get expensive fast.
