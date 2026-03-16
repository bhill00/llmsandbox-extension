from __future__ import annotations

import os
import uuid
import time
import logging
from typing import List, Optional, Tuple

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("llmsandbox")

API_URL = os.environ.get("BEDROCK_API_URL")
API_KEY = os.environ.get("BEDROCK_API_KEY")

if not API_URL or not API_KEY:
    raise RuntimeError("BEDROCK_API_URL and BEDROCK_API_KEY must be set")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Configuration (all from environment, set by the VS Code extension)
# ---------------------------------------------------------------------------
CONTEXT_BUDGET = int(os.environ.get("CONTEXT_BUDGET", "20000"))  # tokens
CONTEXT_STRATEGY = os.environ.get("CONTEXT_STRATEGY", "summary")  # recent | summary | key-facts
RECENT_TURNS_TO_KEEP = int(os.environ.get("RECENT_TURNS_TO_KEEP", "6"))
ENABLE_REASONING = os.environ.get("ENABLE_REASONING", "false").lower() == "true"
AUTO_INCLUDE_ACTIVE_FILE = os.environ.get("AUTO_INCLUDE_ACTIVE_FILE", "true").lower() == "true"
CUSTOM_SYSTEM_PROMPT = os.environ.get("SYSTEM_PROMPT", "")
POLL_INTERVAL = max(1, int(os.environ.get("POLL_INTERVAL", "2")))
POLL_TIMEOUT = max(5, int(os.environ.get("POLL_TIMEOUT", "30")))
POLL_MAX_ATTEMPTS = max(1, POLL_TIMEOUT // POLL_INTERVAL)
CHARS_PER_TOKEN = 4  # rough estimate

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------
DEFAULT_SYSTEM_PROMPT = """You are a coding assistant integrated into VS Code. You can read and modify files in the user's workspace.

When you want to create or modify a file, use this exact format:

===FILE: path/to/file.ext===
full file contents here
===END FILE===

You can include multiple file blocks in one response. Always include the COMPLETE file content, not just the changed parts. The user will be shown a diff and can accept or reject each file change.

When discussing code, explain your reasoning briefly, then provide the file blocks. If the user shares file contents with you, reference specific line numbers when relevant."""

SYSTEM_PROMPT = CUSTOM_SYSTEM_PROMPT if CUSTOM_SYSTEM_PROMPT else DEFAULT_SYSTEM_PROMPT

# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------
history: list[tuple[str, str]] = []       # all (role, msg) pairs
rolling_summary: str = ""                  # compressed older context
current_model: str = "claude-v4.5-sonnet"

BOT_HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}


class ChatRequest(BaseModel):
    message: str
    model: Optional[str] = None
    active_file: Optional[str] = None
    active_file_content: Optional[str] = None


class ModelRequest(BaseModel):
    model: str


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------
def estimate_tokens(text: str) -> int:
    return len(text) // CHARS_PER_TOKEN


# ---------------------------------------------------------------------------
# Internal helper: send a message and poll for reply (used by summarization)
# ---------------------------------------------------------------------------
def _send_and_poll(message_text: str) -> str:
    """Fire a one-shot message to the Bot API and poll for the reply.

    Uses a fresh conversation each call since this is for internal
    summarization/extraction, not user-facing queries.
    """
    conv_id = str(uuid.uuid4())
    payload = {
        "conversationId": conv_id,
        "message": {
            "content": [{"contentType": "text", "body": message_text}],
            "model": current_model,
        },
        "continueGenerate": False,
        "enableReasoning": False,
    }

    post_resp = requests.post(
        f"{API_URL}/conversation", headers=BOT_HEADERS, json=payload
    )
    post_resp.raise_for_status()
    server_id = post_resp.json().get("messageId")

    return poll_for_reply(conv_id, server_id)


# ---------------------------------------------------------------------------
# Strategy: Summary — rolling prose summary of older turns
# ---------------------------------------------------------------------------
def summarize_turns(existing_summary: str, turns: list[tuple[str, str]]) -> str:
    """Ask the LLM to compress older turns into a rolling summary."""
    conversation_block = "\n".join(f"{role}: {msg}" for role, msg in turns)

    prompt_parts = [
        "You are a context summarizer. Produce a concise summary that preserves:",
        "- Key decisions and conclusions",
        "- File paths and code changes discussed",
        "- Outstanding tasks or open questions",
        "- User preferences and corrections",
        "",
    ]

    if existing_summary:
        prompt_parts.append("Previous rolling summary:")
        prompt_parts.append(existing_summary)
        prompt_parts.append("")

    prompt_parts.append("New conversation turns to fold in:")
    prompt_parts.append(conversation_block)
    prompt_parts.append("")
    prompt_parts.append(
        "Write ONLY the updated summary. Be concise but preserve all "
        "actionable detail. No preamble."
    )

    return _send_and_poll("\n".join(prompt_parts))


# ---------------------------------------------------------------------------
# Strategy: Key Facts — structured fact extraction from older turns
# ---------------------------------------------------------------------------
def extract_key_facts(existing_facts: str, turns: list[tuple[str, str]]) -> str:
    """Ask the LLM to extract structured key facts from older turns."""
    conversation_block = "\n".join(f"{role}: {msg}" for role, msg in turns)

    prompt_parts = [
        "You are a fact extractor. From the conversation below, extract key structured facts.",
        "Organize facts into these categories:",
        "",
        "## Files",
        "File paths discussed, created, or modified",
        "",
        "## Decisions",
        "Design decisions, implementation choices, and agreements",
        "",
        "## Preferences",
        "User preferences, corrections, and style requirements",
        "",
        "## Issues",
        "Bugs, errors, or problems identified",
        "",
        "## Tasks",
        "Outstanding work items or next steps",
        "",
        "Format: one fact per line, prefixed with '- ', grouped under category headers.",
        "Omit empty categories.",
        "",
    ]

    if existing_facts:
        prompt_parts.append("Existing facts to merge with (update or remove outdated ones):")
        prompt_parts.append(existing_facts)
        prompt_parts.append("")

    prompt_parts.append("New conversation turns to extract from:")
    prompt_parts.append(conversation_block)
    prompt_parts.append("")
    prompt_parts.append(
        "Write ONLY the updated fact list. Merge with existing facts, "
        "removing duplicates and outdated items. No preamble."
    )

    result = _send_and_poll("\n".join(prompt_parts))

    # Post-process: keep only lines that are headers or bullet points
    cleaned = []
    for line in result.split("\n"):
        stripped = line.strip()
        if stripped.startswith("##") or stripped.startswith("- ") or stripped == "":
            cleaned.append(line)
    return "\n".join(cleaned).strip() if cleaned else result


# ---------------------------------------------------------------------------
# Context management
# ---------------------------------------------------------------------------
def _naive_truncation(older: list[tuple[str, str]]) -> None:
    """Fallback: just keep the tail of older turns as text."""
    global rolling_summary
    keep_chars = CONTEXT_BUDGET * CHARS_PER_TOKEN // 2
    rolling_summary = (rolling_summary + "\n" + "\n".join(
        f"{r}: {m}" for r, m in older
    ))[-keep_chars:]


def maybe_compress_history() -> None:
    """If history exceeds the token budget, compress older turns."""
    global rolling_summary, history

    # Estimate current cost of putting everything into the prompt
    history_text = "\n".join(f"{r}: {m}" for r, m in history)
    total = (
        estimate_tokens(SYSTEM_PROMPT)
        + estimate_tokens(rolling_summary)
        + estimate_tokens(history_text)
    )

    if total <= CONTEXT_BUDGET:
        return  # still within budget

    # Split: older turns to compress, recent turns to keep verbatim
    split = max(0, len(history) - RECENT_TURNS_TO_KEEP)
    if split == 0:
        return  # nothing old enough to compress

    older = history[:split]
    history[:] = history[split:]

    log.info(
        "Compressing %d older turns via '%s' strategy (budget %d, was %d)",
        len(older),
        CONTEXT_STRATEGY,
        CONTEXT_BUDGET,
        total,
    )

    if CONTEXT_STRATEGY == "recent":
        # Just discard older turns entirely — zero overhead
        rolling_summary = ""
        log.info("Dropped %d older turns (recent-only strategy)", len(older))

    elif CONTEXT_STRATEGY == "key-facts":
        try:
            rolling_summary = extract_key_facts(rolling_summary, older)
            log.info(
                "Key facts updated (%d tokens)",
                estimate_tokens(rolling_summary),
            )
        except Exception as exc:
            log.warning("Key-fact extraction failed (%s), using naive truncation", exc)
            _naive_truncation(older)

    else:  # "summary" (default)
        try:
            rolling_summary = summarize_turns(rolling_summary, older)
            log.info(
                "Summary updated (%d tokens)",
                estimate_tokens(rolling_summary),
            )
        except Exception as exc:
            log.warning("Summarization failed (%s), using naive truncation", exc)
            _naive_truncation(older)


def build_context(
    user_input: str,
    active_file: Optional[str] = None,
    active_file_content: Optional[str] = None,
) -> str:
    parts = [SYSTEM_PROMPT, ""]

    if rolling_summary:
        if CONTEXT_STRATEGY == "key-facts":
            parts.append("Key facts from earlier conversation:")
        else:
            parts.append("Conversation summary so far:")
        parts.append(rolling_summary)
        parts.append("")

    if history:
        parts.append("Recent conversation:")
        for role, msg in history:
            parts.append(f"{role}: {msg}")
        parts.append("")

    if active_file and active_file_content:
        parts.append(f"Currently open file: {active_file}")
        parts.append(f"--- {active_file} ---")
        parts.append(active_file_content)
        parts.append(f"--- end {active_file} ---")
        parts.append("")

    parts.append(f"Current message:\n{user_input}")

    prompt = "\n".join(parts)
    log.info(
        "Prompt size: ~%d tokens (budget: %d, strategy: %s)",
        estimate_tokens(prompt),
        CONTEXT_BUDGET,
        CONTEXT_STRATEGY,
    )
    return prompt


# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------
def poll_for_reply(conv_id: str, message_id: str) -> str:
    """Poll the per-message endpoint until the assistant reply appears."""
    for attempt in range(POLL_MAX_ATTEMPTS):
        time.sleep(POLL_INTERVAL)
        resp = requests.get(
            f"{API_URL}/conversation/{conv_id}/{message_id}",
            headers=BOT_HEADERS,
        )
        if resp.status_code == 404:
            log.debug("Poll attempt %d/%d — reply not created yet", attempt + 1, POLL_MAX_ATTEMPTS)
            continue
        resp.raise_for_status()
        data = resp.json()

        msg = data.get("message", {})
        if msg.get("role") == "assistant":
            content = msg.get("content", [])
            if content:
                return content[0].get("body", "")

        log.debug("Poll attempt %d/%d — no reply yet", attempt + 1, POLL_MAX_ATTEMPTS)

    raise HTTPException(status_code=504, detail="Timed out waiting for response")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.post("/chat")
def chat(req: ChatRequest):
    global current_model

    if req.model:
        current_model = req.model

    # Compress history if over budget before building the prompt
    maybe_compress_history()

    full_message = build_context(req.message, req.active_file, req.active_file_content)
    conv_id = str(uuid.uuid4())  # fresh conversation each call — we manage context client-side

    payload = {
        "conversationId": conv_id,
        "message": {
            "content": [{"contentType": "text", "body": full_message}],
            "model": current_model,
        },
        "continueGenerate": False,
        "enableReasoning": ENABLE_REASONING,
    }

    post_resp = requests.post(
        f"{API_URL}/conversation", headers=BOT_HEADERS, json=payload
    )
    post_resp.raise_for_status()
    server_message_id = post_resp.json().get("messageId")

    reply = poll_for_reply(conv_id, server_message_id)

    # Store original input (not the full context) to avoid compounding
    history.append(("user", req.message))
    history.append(("assistant", reply))

    return {"reply": reply, "model": current_model}


@app.post("/reset")
def reset():
    global history, rolling_summary
    history = []
    rolling_summary = ""
    return {"status": "reset"}


@app.post("/model")
def set_model(req: ModelRequest):
    global current_model
    current_model = req.model
    return {"model": current_model}


@app.get("/status")
def status():
    return {
        "model": current_model,
        "message_count": len(history),
        "summary_tokens": estimate_tokens(rolling_summary),
        "context_budget": CONTEXT_BUDGET,
        "context_strategy": CONTEXT_STRATEGY,
        "enable_reasoning": ENABLE_REASONING,
        "recent_turns_to_keep": RECENT_TURNS_TO_KEEP,
        "poll_interval": POLL_INTERVAL,
        "poll_timeout": POLL_TIMEOUT,
    }
