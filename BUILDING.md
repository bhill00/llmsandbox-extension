# Building from Source

## Prerequisites

- **Node.js** v18 or newer — [nodejs.org](https://nodejs.org/)
- **npm** — included with Node.js

Python is **not** needed to build the extension. It is only required at runtime when the extension starts its local server.

## Build Steps

```bash
# Clone the repo
git clone https://github.com/bhill00/llmsandbox-extension.git
cd llmsandbox-extension

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package the VSIX
npx @vscode/vsce package --allow-missing-repository
```

This produces `llmsandbox-extension-0.1.0.vsix` in the project root.

## Install the VSIX

```bash
code --install-extension llmsandbox-extension-0.1.0.vsix
```

Or in VS Code: Extensions sidebar > `...` menu > "Install from VSIX..."

## Development

To watch for changes and recompile automatically:

```bash
npm run watch
```

Then reload the VS Code window (`Ctrl+Shift+P` > "Developer: Reload Window") to pick up changes.

## Project Structure

```
src/
  extension.ts          — Extension entry point, command registration
  chatViewProvider.ts   — Webview UI, message handling, diff rendering
  serverManager.ts      — Python server lifecycle (venv, start, stop)
server.py               — FastAPI server (context management, API bridge)
media/
  icon.svg              — Activity bar icon
```
