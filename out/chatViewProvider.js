"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
class ChatViewProvider {
    constructor(extensionUri, serverManager) {
        this.extensionUri = extensionUri;
        this.serverManager = serverManager;
        this.serverManager.setOnStateChange((state) => {
            this.postMessage({ type: "serverState", value: state });
        });
    }
    getApiBase() {
        return `http://127.0.0.1:${this.serverManager.getPort()}`;
    }
    resolveWebviewView(webviewView) {
        this.webviewView = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this.getHtml();
        // Send initial state
        this.postMessage({ type: "serverState", value: this.serverManager.getState() });
        // Send current config for the banner
        const config = vscode.workspace.getConfiguration("llmsandbox");
        this.postMessage({
            type: "configState",
            apiUrl: config.get("apiUrl", ""),
            apiKeySet: !!config.get("apiKey", ""),
        });
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case "chat":
                    await this.handleChat(msg.text);
                    break;
                case "reset":
                    await this.resetConversation();
                    break;
                case "applyFile":
                    await this.applyFileChange(msg.filePath, msg.content);
                    break;
                case "openFile":
                    await this.openFile(msg.filePath);
                    break;
                case "setModel":
                    await this.setModel(msg.model);
                    break;
                case "openSettings":
                    vscode.commands.executeCommand("workbench.action.openSettings", "llmsandbox");
                    break;
                case "restartServer":
                    this.serverManager.restart();
                    break;
                case "startServer":
                    this.serverManager.start();
                    break;
                case "saveSettings":
                    await this.saveSettingsAndStart(msg.apiUrl, msg.apiKey);
                    break;
            }
        });
    }
    async handleChat(text) {
        // Resolve @file references
        const resolved = await this.resolveFileReferences(text);
        // Get active editor context (if enabled)
        const autoInclude = vscode.workspace.getConfiguration("llmsandbox").get("autoIncludeActiveFile", true);
        const editor = vscode.window.activeTextEditor;
        let activeFile;
        let activeFileContent;
        if (autoInclude && editor && !editor.document.isUntitled) {
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            if (wsFolder) {
                activeFile = path.relative(wsFolder.uri.fsPath, editor.document.uri.fsPath);
            }
            else {
                activeFile = editor.document.fileName;
            }
            activeFileContent = editor.document.getText();
        }
        this.postMessage({ type: "thinking", value: true });
        try {
            const body = { message: resolved };
            if (activeFile) {
                body.active_file = activeFile;
                body.active_file_content = activeFileContent;
            }
            const resp = await fetch(`${this.getApiBase()}/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!resp.ok) {
                const err = await resp.text();
                this.postMessage({ type: "error", value: `Server error: ${err}` });
                return;
            }
            const data = (await resp.json());
            // Extract file paths from ===FILE: path=== blocks and read originals
            const fileOriginals = {};
            const fileRegex = /===FILE:\s*([^=]+?)===/g;
            let fileMatch;
            while ((fileMatch = fileRegex.exec(data.reply)) !== null) {
                const fp = fileMatch[1].trim();
                try {
                    const wsFolder = vscode.workspace.workspaceFolders?.[0];
                    if (wsFolder) {
                        const uri = vscode.Uri.joinPath(wsFolder.uri, fp);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        fileOriginals[fp] = doc.getText();
                    }
                }
                catch {
                    // File doesn't exist yet — new file, no original
                }
            }
            this.postMessage({ type: "reply", value: data.reply, model: data.model, fileOriginals });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.postMessage({
                type: "error",
                value: `Cannot reach server at ${this.getApiBase()}. Is the FastAPI server running?\n\n${message}`,
            });
        }
        finally {
            this.postMessage({ type: "thinking", value: false });
        }
    }
    async resetConversation() {
        try {
            await fetch(`${this.getApiBase()}/reset`, { method: "POST" });
            this.postMessage({ type: "reset" });
            vscode.window.showInformationMessage("Conversation reset.");
        }
        catch {
            vscode.window.showErrorMessage("Failed to reset — is the server running?");
        }
    }
    async saveSettingsAndStart(apiUrl, apiKey) {
        const config = vscode.workspace.getConfiguration("llmsandbox");
        await config.update("apiUrl", apiUrl, vscode.ConfigurationTarget.Global);
        await config.update("apiKey", apiKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("LLM Sandbox: Settings saved. Starting server...");
        this.serverManager.restart();
    }
    async setModel(model) {
        try {
            await fetch(`${this.getApiBase()}/model`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model }),
            });
            this.postMessage({ type: "modelChanged", value: model });
            vscode.window.showInformationMessage(`Model switched to ${model}`);
        }
        catch {
            vscode.window.showErrorMessage("Failed to switch model — is the server running?");
        }
    }
    async resolveFileReferences(text) {
        const pattern = /@(\S+)/g;
        let match;
        let resolved = text;
        while ((match = pattern.exec(text)) !== null) {
            const filename = match[1];
            const files = await vscode.workspace.findFiles(`**/${filename}`, null, 1);
            if (files.length > 0) {
                const doc = await vscode.workspace.openTextDocument(files[0]);
                const content = doc.getText();
                resolved = resolved.replace(match[0], `\n--- ${filename} ---\n${content}\n--- end ${filename} ---\n`);
            }
        }
        return resolved;
    }
    async applyFileChange(filePath, content) {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) {
            vscode.window.showErrorMessage("No workspace folder open.");
            return;
        }
        const fullUri = vscode.Uri.joinPath(wsFolder.uri, filePath);
        // Check if file exists
        let existingDoc;
        try {
            existingDoc = await vscode.workspace.openTextDocument(fullUri);
        }
        catch {
            // File doesn't exist — create it
        }
        if (existingDoc) {
            // Show diff before applying
            const proposedUri = fullUri.with({ scheme: "untitled", path: fullUri.path + ".proposed" });
            // Write proposed content to a temp doc and diff
            const accept = await vscode.window.showInformationMessage(`Apply changes to ${filePath}?`, { modal: true, detail: "This will overwrite the file contents." }, "Apply", "Open Diff", "Cancel");
            if (accept === "Open Diff") {
                // Show side-by-side before deciding
                const originalContent = existingDoc.getText();
                const originalUri = vscode.Uri.parse(`llmsandbox-original:${filePath}`);
                const proposedContentUri = vscode.Uri.parse(`llmsandbox-proposed:${filePath}`);
                // Register content providers temporarily
                const originalProvider = new (class {
                    provideTextDocumentContent() { return originalContent; }
                })();
                const proposedProvider = new (class {
                    provideTextDocumentContent() { return content; }
                })();
                const d1 = vscode.workspace.registerTextDocumentContentProvider("llmsandbox-original", originalProvider);
                const d2 = vscode.workspace.registerTextDocumentContentProvider("llmsandbox-proposed", proposedProvider);
                await vscode.commands.executeCommand("vscode.diff", originalUri, proposedContentUri, `${filePath}: Proposed Changes`);
                const confirm = await vscode.window.showInformationMessage(`Apply these changes to ${filePath}?`, "Apply", "Cancel");
                d1.dispose();
                d2.dispose();
                if (confirm !== "Apply") {
                    return;
                }
            }
            else if (accept !== "Apply") {
                return;
            }
            // Apply the edit
            const edit = new vscode.WorkspaceEdit();
            edit.replace(fullUri, new vscode.Range(existingDoc.lineAt(0).range.start, existingDoc.lineAt(existingDoc.lineCount - 1).range.end), content);
            await vscode.workspace.applyEdit(edit);
            await existingDoc.save();
            vscode.window.showInformationMessage(`Updated ${filePath}`);
        }
        else {
            // New file
            const accept = await vscode.window.showInformationMessage(`Create new file ${filePath}?`, "Create", "Cancel");
            if (accept !== "Create") {
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(fullUri, { ignoreIfExists: true });
            edit.insert(fullUri, new vscode.Position(0, 0), content);
            await vscode.workspace.applyEdit(edit);
            vscode.window.showInformationMessage(`Created ${filePath}`);
        }
        // Open the file
        const doc = await vscode.workspace.openTextDocument(fullUri);
        await vscode.window.showTextDocument(doc);
    }
    async openFile(filePath) {
        const files = await vscode.workspace.findFiles(`**/${filePath}`, null, 1);
        if (files.length > 0) {
            const doc = await vscode.workspace.openTextDocument(files[0]);
            await vscode.window.showTextDocument(doc);
        }
    }
    postMessage(msg) {
        this.webviewView?.webview.postMessage(msg);
    }
    getHtml() {
        // Build regex patterns outside template literal to avoid backtick issues
        const FILE_BLOCK_REGEX = "===FILE:\\\\s*([^=]+?)===\\\\n([\\\\s\\\\S]*?)===END FILE===";
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --input-bg: var(--vscode-input-background);
    --input-border: var(--vscode-input-border);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --border: var(--vscode-panel-border);
    --success: #4ec9b0;
    --warning: #ce9178;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
  .msg {
    margin-bottom: 12px;
    line-height: 1.5;
  }
  .msg-role {
    font-weight: bold;
    font-size: 0.85em;
    text-transform: uppercase;
    margin-bottom: 4px;
    opacity: 0.7;
  }
  .msg-body {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .msg-body code {
    background: rgba(127,127,127,0.15);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
  }
  .msg-body pre {
    background: rgba(0,0,0,0.2);
    padding: 8px;
    padding-top: 28px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 6px 0;
    position: relative;
  }
  .msg-body pre code {
    background: none;
    padding: 0;
  }
  .code-actions {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    gap: 4px;
  }
  .code-actions button {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.75em;
  }
  .code-actions button:hover { opacity: 0.8; }
  .file-block {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 8px 0;
    overflow: hidden;
  }
  .file-block-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    background: rgba(127,127,127,0.1);
    font-size: 0.85em;
    font-family: var(--vscode-editor-font-family);
  }
  .file-block-header .file-path {
    color: var(--success);
    cursor: pointer;
    text-decoration: underline;
  }
  .file-block-actions {
    display: flex;
    gap: 4px;
  }
  .file-block-actions button {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    padding: 3px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.8em;
  }
  .file-block-actions button.applied {
    background: var(--success);
    color: #000;
  }
  .file-block pre {
    margin: 0;
    border-radius: 0;
    padding-top: 8px;
    max-height: 400px;
    overflow-y: auto;
  }
  .diff-line {
    display: block;
    padding: 0 8px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    white-space: pre;
  }
  .diff-add {
    background: rgba(40, 167, 69, 0.2);
    color: #4ec9b0;
  }
  .diff-remove {
    background: rgba(220, 53, 69, 0.2);
    color: #f48771;
    text-decoration: line-through;
    opacity: 0.7;
  }
  .diff-context {
    opacity: 0.6;
  }
  .diff-separator {
    color: #569cd6;
    opacity: 0.8;
    padding: 2px 8px;
    font-style: italic;
  }
  .diff-toggle {
    display: flex;
    gap: 4px;
  }
  .diff-toggle button {
    background: none;
    color: var(--fg);
    border: 1px solid var(--border);
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.75em;
    opacity: 0.6;
  }
  .diff-toggle button.active {
    opacity: 1;
    border-color: var(--btn-bg);
    background: rgba(127,127,127,0.15);
  }
  .new-file-badge {
    font-size: 0.75em;
    background: var(--success);
    color: #000;
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 6px;
  }
  .user-msg { }
  .assistant-msg {
    border-left: 3px solid var(--btn-bg);
    padding-left: 10px;
  }
  .error-msg {
    color: var(--vscode-errorForeground);
    border-left: 3px solid var(--vscode-errorForeground);
    padding-left: 10px;
  }
  #spinner {
    display: none;
    padding: 8px 12px;
    opacity: 0.7;
    font-style: italic;
  }
  #input-area {
    border-top: 1px solid var(--border);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  #input-area textarea {
    flex: 1;
    background: var(--input-bg);
    color: var(--fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    resize: vertical;
    min-height: 80px;
    max-height: 200px;
  }
  #input-area button {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
    width: 100%;
  }
  #input-area button:hover { background: var(--btn-hover); }
  #toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    font-size: 0.8em;
    border-bottom: 1px solid var(--border);
    gap: 6px;
  }
  #toolbar a, #toolbar button.icon-btn {
    color: var(--fg);
    cursor: pointer;
    text-decoration: none;
    opacity: 0.7;
    background: none;
    border: none;
    font-size: inherit;
    font-family: inherit;
    padding: 2px 4px;
    border-radius: 3px;
  }
  #toolbar a:hover, #toolbar button.icon-btn:hover {
    opacity: 1;
    background: rgba(127,127,127,0.2);
  }
  #toolbar select {
    background: var(--input-bg);
    color: var(--fg);
    border: 1px solid var(--input-border);
    border-radius: 3px;
    padding: 2px 4px;
    font-size: inherit;
    font-family: inherit;
    cursor: pointer;
    max-width: 150px;
  }
  #server-status {
    font-size: 0.75em;
    padding: 2px 8px;
    border-radius: 3px;
  }
  #server-status.running { color: var(--success); }
  #server-status.stopped { color: var(--warning); }
  #server-status.starting { color: #dcdcaa; }
  #server-status.error { color: #f48771; }
  #setup-banner {
    padding: 12px;
    margin: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: rgba(127,127,127,0.08);
    text-align: center;
  }
  #setup-banner.hidden { display: none; }
  #setup-banner p {
    margin-bottom: 8px;
    opacity: 0.8;
    font-size: 0.9em;
  }
  #setup-banner .banner-actions {
    display: flex;
    gap: 6px;
    justify-content: center;
  }
  #setup-banner button {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
  }
  #setup-banner button:hover { background: var(--btn-hover); }
  #setup-banner button.secondary {
    background: rgba(127,127,127,0.2);
    color: var(--fg);
  }
  #setup-banner button.secondary:hover {
    background: rgba(127,127,127,0.35);
  }
  .config-fields {
    text-align: left;
    margin-bottom: 10px;
  }
  .config-fields label {
    display: block;
    font-size: 0.8em;
    opacity: 0.7;
    margin-top: 6px;
    margin-bottom: 2px;
  }
  .config-fields input {
    width: 100%;
    background: var(--input-bg);
    color: var(--fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    padding: 5px 8px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.85em;
  }
  .key-field {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .key-field input { flex: 1; }
  .key-field .icon-btn {
    background: none;
    border: none;
    color: var(--fg);
    cursor: pointer;
    opacity: 0.6;
    font-size: 1em;
    padding: 4px;
  }
  .key-field .icon-btn:hover { opacity: 1; }
</style>
</head>
<body>
  <div id="toolbar">
    <select id="model-select">
      <option value="claude-v4.5-sonnet">Sonnet 4.5</option>
      <option value="claude-v4-sonnet">Sonnet 4</option>
      <option value="claude-v3.5-sonnet">Sonnet 3.5</option>
    </select>
    <span id="server-status" class="stopped">stopped</span>
    <button class="icon-btn" id="restart-btn" title="Restart server">&#x21bb;</button>
    <a id="reset-btn" title="Reset conversation">Reset</a>
    <button class="icon-btn" id="settings-btn" title="Settings">&#x2699;</button>
  </div>
  <div id="setup-banner" class="hidden">
    <p>Configure your API credentials to get started.</p>
    <div class="config-fields">
      <label>API URL</label>
      <input type="text" id="cfg-url" placeholder="https://xxx.execute-api.us-east-1.amazonaws.com/api" />
      <label>API Key</label>
      <div class="key-field">
        <input type="password" id="cfg-key" placeholder="Enter API key" />
        <button class="icon-btn" id="toggle-key" title="Show/hide key">&#x1f441;</button>
      </div>
    </div>
    <div class="banner-actions">
      <button id="banner-save-btn">Save &amp; Start</button>
      <button id="banner-settings-btn" class="secondary">VS Code Settings</button>
    </div>
  </div>
  <div id="messages"></div>
  <div id="spinner">Thinking...</div>
  <div id="input-area">
    <textarea id="input" placeholder="Ask anything... use @filename to include files" rows="4"></textarea>
    <button id="send">Send</button>
  </div>

<script>
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var spinnerEl = document.getElementById('spinner');
  var modelSelect = document.getElementById('model-select');
  var serverStatus = document.getElementById('server-status');
  var currentFileOriginals = {};

  var setupBanner = document.getElementById('setup-banner');

  document.getElementById('send').addEventListener('click', send);
  document.getElementById('reset-btn').addEventListener('click', function() {
    vscode.postMessage({ type: 'reset' });
  });
  document.getElementById('settings-btn').addEventListener('click', function() {
    vscode.postMessage({ type: 'openSettings' });
  });
  document.getElementById('restart-btn').addEventListener('click', function() {
    vscode.postMessage({ type: 'restartServer' });
  });
  document.getElementById('banner-settings-btn').addEventListener('click', function() {
    vscode.postMessage({ type: 'openSettings' });
  });
  document.getElementById('banner-save-btn').addEventListener('click', function() {
    var url = document.getElementById('cfg-url').value.trim();
    var key = document.getElementById('cfg-key').value.trim();
    if (!url || !key) {
      return;
    }
    vscode.postMessage({ type: 'saveSettings', apiUrl: url, apiKey: key });
  });
  document.getElementById('toggle-key').addEventListener('click', function() {
    var keyInput = document.getElementById('cfg-key');
    if (keyInput.type === 'password') {
      keyInput.type = 'text';
    } else {
      keyInput.type = 'password';
    }
  });

  modelSelect.addEventListener('change', function() {
    vscode.postMessage({ type: 'setModel', model: modelSelect.value });
  });

  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function send() {
    var text = inputEl.value.trim();
    if (!text) return;
    addMessage('You', text, 'user-msg', {});
    vscode.postMessage({ type: 'chat', text: text });
    inputEl.value = '';
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* ---- Simple LCS-based diff ---- */
  function computeDiff(oldStr, newStr) {
    var oldLines = oldStr ? oldStr.split('\\n') : [];
    var newLines = newStr.split('\\n');

    // Build LCS table
    var m = oldLines.length, n = newLines.length;
    var dp = [];
    for (var i = 0; i <= m; i++) {
      dp[i] = [];
      for (var j = 0; j <= n; j++) {
        if (i === 0 || j === 0) dp[i][j] = 0;
        else if (oldLines[i-1] === newLines[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
        else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
      }
    }

    // Backtrack to get diff ops
    var result = [];
    var i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i-1] === newLines[j-1]) {
        result.unshift({ type: 'context', line: oldLines[i-1], oldNum: i, newNum: j });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
        result.unshift({ type: 'add', line: newLines[j-1], newNum: j });
        j--;
      } else {
        result.unshift({ type: 'remove', line: oldLines[i-1], oldNum: i });
        i--;
      }
    }
    return result;
  }

  function renderDiff(oldContent, newContent) {
    var ops = computeDiff(oldContent, newContent);
    var container = document.createElement('div');
    container.className = 'diff-view';

    // Collapse unchanged regions, show 3 lines of context around changes
    var CONTEXT = 3;
    var changeIndices = [];
    ops.forEach(function(op, idx) {
      if (op.type !== 'context') changeIndices.push(idx);
    });

    if (changeIndices.length === 0) {
      var noChange = document.createElement('span');
      noChange.className = 'diff-separator';
      noChange.textContent = '(no changes)';
      container.appendChild(noChange);
      return container;
    }

    var visible = {};
    changeIndices.forEach(function(ci) {
      for (var k = Math.max(0, ci - CONTEXT); k <= Math.min(ops.length - 1, ci + CONTEXT); k++) {
        visible[k] = true;
      }
    });

    var lastShown = -1;
    ops.forEach(function(op, idx) {
      if (!visible[idx]) return;

      if (lastShown >= 0 && idx - lastShown > 1) {
        var sep = document.createElement('span');
        sep.className = 'diff-line diff-separator';
        sep.textContent = '  ...';
        container.appendChild(sep);
      }

      var line = document.createElement('span');
      line.className = 'diff-line';

      var prefix = '  ';
      if (op.type === 'add') {
        line.className += ' diff-add';
        prefix = '+ ';
      } else if (op.type === 'remove') {
        line.className += ' diff-remove';
        prefix = '- ';
      } else {
        line.className += ' diff-context';
      }

      line.textContent = prefix + op.line;
      container.appendChild(line);
      lastShown = idx;
    });

    return container;
  }

  function renderFullContent(content) {
    var container = document.createElement('pre');
    var code = document.createElement('code');
    code.textContent = content;
    container.appendChild(code);
    return container;
  }

  function parseFileBlocks(text) {
    var regex = /===FILE:\\s*([^=]+?)===\\n([\\s\\S]*?)===END FILE===/g;
    var match;
    var lastIndex = 0;
    var parts = [];

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: text.substring(lastIndex, match.index) });
      }
      parts.push({ type: 'file', path: match[1].trim(), content: match[2] });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
      parts.push({ type: 'text', content: text.substring(lastIndex) });
    }
    return parts;
  }

  function formatText(text) {
    var html = escapeHtml(text);
    var BT = String.fromCharCode(96);
    var cbPat = BT+BT+BT+'(\\\\w*)\\n([\\\\s\\\\S]*?)'+BT+BT+BT;
    html = html.replace(new RegExp(cbPat, 'g'), '<pre><code>$2</code></pre>');
    var icPat = BT+'([^'+BT+']+)'+BT;
    html = html.replace(new RegExp(icPat, 'g'), '<code>$1</code>');
    return html;
  }

  function addMessage(role, body, cls, fileOriginals) {
    var div = document.createElement('div');
    div.className = 'msg ' + cls;

    var roleDiv = document.createElement('div');
    roleDiv.className = 'msg-role';
    roleDiv.textContent = role;
    div.appendChild(roleDiv);

    var bodyDiv = document.createElement('div');
    bodyDiv.className = 'msg-body';

    if (cls === 'assistant-msg') {
      var parts = parseFileBlocks(body);
      parts.forEach(function(part) {
        if (part.type === 'text') {
          var textSpan = document.createElement('span');
          textSpan.innerHTML = formatText(part.content);
          bodyDiv.appendChild(textSpan);
        } else {
          var original = (fileOriginals && fileOriginals[part.path]) || null;
          var fileBlock = createFileBlock(part.path, part.content, original);
          bodyDiv.appendChild(fileBlock);
        }
      });
    } else {
      bodyDiv.innerHTML = formatText(body);
    }

    div.appendChild(bodyDiv);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function createFileBlock(filePath, content, originalContent) {
    var isNewFile = (originalContent === null);
    var block = document.createElement('div');
    block.className = 'file-block';

    var header = document.createElement('div');
    header.className = 'file-block-header';

    var leftSide = document.createElement('div');

    var pathSpan = document.createElement('span');
    pathSpan.className = 'file-path';
    pathSpan.textContent = filePath;
    pathSpan.addEventListener('click', function() {
      vscode.postMessage({ type: 'openFile', filePath: filePath });
    });
    leftSide.appendChild(pathSpan);

    if (isNewFile) {
      var badge = document.createElement('span');
      badge.className = 'new-file-badge';
      badge.textContent = 'NEW';
      leftSide.appendChild(badge);
    }

    var rightSide = document.createElement('div');
    rightSide.style.display = 'flex';
    rightSide.style.gap = '4px';
    rightSide.style.alignItems = 'center';

    // Diff / Full toggle (only if existing file)
    if (!isNewFile) {
      var toggle = document.createElement('div');
      toggle.className = 'diff-toggle';
      var diffBtn = document.createElement('button');
      diffBtn.textContent = 'Diff';
      diffBtn.className = 'active';
      var fullBtn = document.createElement('button');
      fullBtn.textContent = 'Full';
      toggle.appendChild(diffBtn);
      toggle.appendChild(fullBtn);
      rightSide.appendChild(toggle);
    }

    var actions = document.createElement('div');
    actions.className = 'file-block-actions';

    var applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'applyFile', filePath: filePath, content: content });
      applyBtn.textContent = 'Applied';
      applyBtn.className = 'applied';
    });

    var copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', function() {
      navigator.clipboard.writeText(content);
      copyBtn.textContent = 'Copied!';
      setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500);
    });

    actions.appendChild(applyBtn);
    actions.appendChild(copyBtn);
    rightSide.appendChild(actions);

    header.appendChild(leftSide);
    header.appendChild(rightSide);

    // Content area
    var contentArea = document.createElement('div');

    if (!isNewFile) {
      // Default to diff view
      var diffView = renderDiff(originalContent, content);
      var fullView = renderFullContent(content);
      fullView.style.display = 'none';
      contentArea.appendChild(diffView);
      contentArea.appendChild(fullView);

      diffBtn.addEventListener('click', function() {
        diffView.style.display = '';
        fullView.style.display = 'none';
        diffBtn.className = 'active';
        fullBtn.className = '';
      });
      fullBtn.addEventListener('click', function() {
        diffView.style.display = 'none';
        fullView.style.display = '';
        fullBtn.className = 'active';
        diffBtn.className = '';
      });
    } else {
      contentArea.appendChild(renderFullContent(content));
    }

    block.appendChild(header);
    block.appendChild(contentArea);
    return block;
  }

  window.addEventListener('message', function(e) {
    var msg = e.data;
    switch (msg.type) {
      case 'reply':
        addMessage('Assistant', msg.value, 'assistant-msg', msg.fileOriginals || {});
        break;
      case 'error':
        addMessage('Error', msg.value, 'error-msg', {});
        break;
      case 'thinking':
        spinnerEl.style.display = msg.value ? 'block' : 'none';
        break;
      case 'reset':
        messagesEl.innerHTML = '';
        break;
      case 'modelChanged':
        modelSelect.value = msg.value;
        break;
      case 'serverState':
        serverStatus.textContent = msg.value;
        serverStatus.className = msg.value;
        if (msg.value === 'stopped' || msg.value === 'error') {
          setupBanner.classList.remove('hidden');
        } else {
          setupBanner.classList.add('hidden');
        }
        break;
      case 'configState':
        if (msg.apiUrl) document.getElementById('cfg-url').value = msg.apiUrl;
        if (msg.apiKeySet) document.getElementById('cfg-key').placeholder = '••••••••  (saved)';
        break;
    }
  });
</script>
</body>
</html>`;
    }
}
exports.ChatViewProvider = ChatViewProvider;
//# sourceMappingURL=chatViewProvider.js.map