# LLM Sandbox — VS Code Extension

A Cline-style AI coding assistant for VS Code that connects to the UCSB LLM Sandbox Bot API. Features a sidebar chat interface with file awareness, inline diffs, model switching, and configurable context management.

![LLM Sandbox Screenshot](SCREENSHOT.png)

## Features

- **Sidebar chat panel** with markdown rendering and code blocks
- **File references** — use `@filename` to include file contents in your message
- **Active file context** — automatically sends the currently open file to the model
- **Inline diffs** — proposed file changes shown as diffs with Apply/Copy buttons
- **Model switcher** — change models mid-conversation from the toolbar
- **Context management** — three strategies for handling long conversations:
  - **Most Recent** — keeps only the last N turns (zero overhead)
  - **Summary** — LLM-generated rolling prose summary of older turns
  - **Key Facts** — extracts structured facts (files, decisions, preferences, issues, tasks)
- **Configurable settings** — context budget, polling, system prompt, reasoning mode, and more
- **Cross-platform** — works on macOS, Linux, and Windows

## Architecture

```
VS Code Extension (TypeScript webview)
    |
    v
FastAPI local server (Python bridge, auto-managed)
    |
    v
UCSB LLM Sandbox Bot API (Claude)
```

The extension automatically manages the Python server — creates a virtual environment, installs dependencies, and starts/stops the server as needed.

## Prerequisites

1. **VS Code** 1.110.0 or newer
2. **Python 3.8+** with `venv` module available
   - **macOS**: `brew install python3`
   - **Windows**: Download from [python.org](https://www.python.org/downloads/) or `winget install Python.Python.3.12`
   - **Linux**: Usually pre-installed. If not: `sudo apt install python3 python3-venv` (Debian/Ubuntu) or `sudo dnf install python3` (Fedora)
3. **UCSB LLM Sandbox Bot API credentials** — you need an API URL and API Key

## Installation

### From VSIX (recommended)

Download the `.vsix` file from the [Releases](../../releases) page, then either:

```bash
code --install-extension llmsandbox-extension-0.1.0.vsix
```

Or in VS Code: Extensions sidebar > `...` menu > "Install from VSIX..."

### From source

See [BUILDING.md](BUILDING.md) for full build instructions. Quick version:

```bash
git clone https://github.com/bhill00/llmsandbox-extension.git
cd llmsandbox-extension
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
code --install-extension llmsandbox-extension-0.1.0.vsix
```

## Getting Started

1. Open VS Code and click the **LLM Sandbox** icon in the activity bar (left sidebar)
2. Enter your **API URL** and **API Key** in the setup banner, then click **Save & Start**
   - Or open settings (`Ctrl+,` / `Cmd+,`) and search for "LLM Sandbox"
3. The server will start automatically — you'll see the status change to "running" in the toolbar
4. Start chatting!

## Settings

All settings are under `llmsandbox.*` in VS Code settings.

| Setting | Default | Description |
|---|---|---|
| `apiUrl` | — | Bedrock API URL |
| `apiKey` | — | Bedrock API Key |
| `serverPort` | `8765` | Local server port |
| `defaultModel` | `claude-v4.5-sonnet` | Default model |
| `pythonPath` | `python3` | Path to Python 3 executable |
| `contextBudget` | `20000` | Context budget in estimated tokens |
| `contextStrategy` | `summary` | Context compression strategy: `recent`, `summary`, or `key-facts` |
| `recentTurnsToKeep` | `6` | Number of recent turns kept verbatim |
| `enableReasoning` | `false` | Enable extended thinking/reasoning |
| `autoIncludeActiveFile` | `true` | Auto-include the open file as context |
| `systemPrompt` | (built-in) | Custom system prompt override |
| `pollInterval` | `2` | Seconds between polling attempts |
| `pollTimeout` | `30` | Max seconds to wait for a response |

> **Note:** Changing settings requires a server restart. Click the restart button (&#x21bb;) in the chat toolbar or run the "LLM Sandbox: Restart Server" command.

## Context Strategies

The Bot API is **stateless** — it doesn't remember previous messages. The extension manages conversation context client-side and prepends it to every request.

When the context exceeds your token budget, older turns are compressed using the selected strategy:

### Most Recent
Drops older turns entirely. Keeps only the last N turns (configurable via `recentTurnsToKeep`). Zero API overhead — best for quick tasks or when you're cost-sensitive.

### Summary (default)
Sends older turns to the LLM with a "summarize this" prompt. The rolling prose summary replaces the older turns. Good balance of context retention and cost. Costs one extra API call when compression triggers.

### Key Facts
Instead of prose, extracts structured facts organized by category (files, decisions, preferences, issues, tasks). Facts are more durable than prose summaries through repeated compression cycles — better for extended coding sessions. Same API cost as summary.

## Commands

- **LLM Sandbox: Reset Conversation** — clear history and start fresh
- **LLM Sandbox: Switch Model** — pick a different model
- **LLM Sandbox: Start/Stop/Restart Server** — manage the local Python server

## Toolbar

The chat panel toolbar includes:
- **Model dropdown** — switch between available models
- **Server status** — shows running/stopped/error state
- **Restart button** (&#x21bb;) — restart the server
- **Reset** — clear conversation history
- **Settings gear** (&#x2699;) — open extension settings

## Troubleshooting

- **Server won't start**: Check the Output panel (View > Output > "LLM Sandbox Server") for error details
- **Python not found**: Set `llmsandbox.pythonPath` to the full path of your Python 3 executable
- **Timeout errors**: Increase `llmsandbox.pollTimeout` in settings
- **Port conflict**: Change `llmsandbox.serverPort` to a different port

## License

MIT
