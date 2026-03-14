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
exports.ServerManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
class ServerManager {
    constructor(extensionPath) {
        this.process = null;
        this.state = "stopped";
        this.onStateChange = null;
        this.extensionPath = extensionPath;
        this.outputChannel = vscode.window.createOutputChannel("LLM Sandbox Server");
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.command = "llmsandbox.restartServer";
        this.statusBar.show();
        this.updateStatusBar();
    }
    setOnStateChange(cb) {
        this.onStateChange = cb;
    }
    getState() {
        return this.state;
    }
    getPort() {
        return vscode.workspace.getConfiguration("llmsandbox").get("serverPort", 8765);
    }
    setState(state) {
        this.state = state;
        this.updateStatusBar();
        this.onStateChange?.(state);
    }
    updateStatusBar() {
        switch (this.state) {
            case "stopped":
                this.statusBar.text = "$(circle-outline) LLM Sandbox: Stopped";
                this.statusBar.tooltip = "Click to restart server";
                this.statusBar.backgroundColor = undefined;
                break;
            case "starting":
                this.statusBar.text = "$(loading~spin) LLM Sandbox: Starting...";
                this.statusBar.tooltip = "Server is starting up";
                this.statusBar.backgroundColor = undefined;
                break;
            case "running":
                this.statusBar.text = "$(circle-filled) LLM Sandbox: Running";
                this.statusBar.tooltip = "Server is running. Click to restart.";
                this.statusBar.backgroundColor = undefined;
                break;
            case "error":
                this.statusBar.text = "$(error) LLM Sandbox: Error";
                this.statusBar.tooltip = "Server error. Click to restart.";
                this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
                break;
        }
    }
    async start() {
        if (this.state === "running" || this.state === "starting") {
            return true;
        }
        // Validate settings
        const config = vscode.workspace.getConfiguration("llmsandbox");
        const apiUrl = config.get("apiUrl", "");
        const apiKey = config.get("apiKey", "");
        if (!apiUrl || !apiKey) {
            const action = await vscode.window.showErrorMessage("LLM Sandbox: API URL and API Key must be configured.", "Open Settings");
            if (action === "Open Settings") {
                vscode.commands.executeCommand("workbench.action.openSettings", "llmsandbox");
            }
            this.setState("error");
            return false;
        }
        const pythonPath = config.get("pythonPath", "python3");
        const port = config.get("serverPort", 8765);
        const contextBudget = config.get("contextBudget", 20000);
        const contextStrategy = config.get("contextStrategy", "summary");
        const recentTurnsToKeep = config.get("recentTurnsToKeep", 6);
        const enableReasoning = config.get("enableReasoning", false);
        const autoIncludeActiveFile = config.get("autoIncludeActiveFile", true);
        const systemPrompt = config.get("systemPrompt", "");
        const pollInterval = config.get("pollInterval", 2);
        const pollTimeout = config.get("pollTimeout", 30);
        // Ensure venv and dependencies
        const ready = await this.ensureDependencies(pythonPath);
        if (!ready) {
            this.setState("error");
            return false;
        }
        this.setState("starting");
        this.outputChannel.appendLine(`Starting server on port ${port}...`);
        const venvPython = this.getVenvPython();
        const serverPy = path.join(this.extensionPath, "server.py");
        this.process = (0, child_process_1.spawn)(venvPython, ["-m", "uvicorn", "server:app", "--port", String(port), "--host", "127.0.0.1"], {
            cwd: this.extensionPath,
            env: {
                ...process.env,
                BEDROCK_API_URL: apiUrl,
                BEDROCK_API_KEY: apiKey,
                CONTEXT_BUDGET: String(contextBudget),
                CONTEXT_STRATEGY: contextStrategy,
                RECENT_TURNS_TO_KEEP: String(recentTurnsToKeep),
                ENABLE_REASONING: String(enableReasoning),
                AUTO_INCLUDE_ACTIVE_FILE: String(autoIncludeActiveFile),
                SYSTEM_PROMPT: systemPrompt,
                POLL_INTERVAL: String(pollInterval),
                POLL_TIMEOUT: String(pollTimeout),
            },
        });
        this.process.stdout?.on("data", (data) => {
            this.outputChannel.append(data.toString());
        });
        this.process.stderr?.on("data", (data) => {
            const text = data.toString();
            this.outputChannel.append(text);
            if (text.includes("Application startup complete") ||
                text.includes("Uvicorn running on")) {
                this.setState("running");
                this.outputChannel.appendLine("Server is ready.");
            }
        });
        this.process.on("exit", (code) => {
            this.outputChannel.appendLine(`Server exited with code ${code}`);
            if (this.state !== "stopped") {
                this.setState("error");
            }
            this.process = null;
        });
        this.process.on("error", (err) => {
            this.outputChannel.appendLine(`Server error: ${err.message}`);
            this.setState("error");
            this.process = null;
        });
        // Wait for server to be ready (poll health)
        const ok = await this.waitForReady(port, 15000);
        const currentState = this.state;
        if (!ok && currentState === "starting") {
            this.outputChannel.appendLine("Server did not become ready in time.");
            this.setState("error");
            return false;
        }
        return currentState === "running";
    }
    async stop() {
        if (!this.process) {
            this.setState("stopped");
            return;
        }
        this.setState("stopped");
        this.outputChannel.appendLine("Stopping server...");
        if (process.platform === "win32") {
            // Windows: use taskkill to kill the process tree
            const pid = this.process.pid;
            if (pid) {
                (0, child_process_1.spawn)("taskkill", ["/pid", String(pid), "/f", "/t"]);
            }
        }
        else {
            this.process.kill("SIGTERM");
        }
        // Give it a moment, then force kill
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (this.process) {
                    try {
                        this.process.kill("SIGKILL");
                    }
                    catch { /* already dead */ }
                }
                resolve();
            }, 3000);
            this.process?.on("exit", () => {
                clearTimeout(timeout);
                resolve();
            });
        });
        this.process = null;
    }
    async restart() {
        await this.stop();
        return this.start();
    }
    async waitForReady(port, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const resp = await fetch(`http://127.0.0.1:${port}/status`);
                if (resp.ok) {
                    this.setState("running");
                    return true;
                }
            }
            catch {
                // Not ready yet
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        return false;
    }
    getVenvPath() {
        return path.join(this.extensionPath, ".venv");
    }
    getVenvPython() {
        const venvPath = this.getVenvPath();
        if (process.platform === "win32") {
            return path.join(venvPath, "Scripts", "python.exe");
        }
        return path.join(venvPath, "bin", "python");
    }
    async ensureDependencies(pythonPath) {
        const venvPath = this.getVenvPath();
        const venvPython = this.getVenvPython();
        // Check if venv exists
        if (!fs.existsSync(venvPython)) {
            this.outputChannel.appendLine("Creating Python virtual environment...");
            const created = await this.runCommand(pythonPath, ["-m", "venv", venvPath]);
            if (!created) {
                vscode.window.showErrorMessage("LLM Sandbox: Failed to create Python venv. Check the Output panel.");
                return false;
            }
        }
        // Check if deps are installed
        const requirementsPath = path.join(this.extensionPath, "requirements.txt");
        const markerPath = path.join(venvPath, ".deps-installed");
        // Recheck if requirements.txt changed
        let needsInstall = !fs.existsSync(markerPath);
        if (!needsInstall && fs.existsSync(requirementsPath)) {
            const reqMtime = fs.statSync(requirementsPath).mtimeMs;
            const markerMtime = fs.statSync(markerPath).mtimeMs;
            if (reqMtime > markerMtime) {
                needsInstall = true;
            }
        }
        if (needsInstall) {
            this.outputChannel.appendLine("Installing Python dependencies...");
            const installed = await this.runCommand(venvPython, [
                "-m",
                "pip",
                "install",
                "-r",
                requirementsPath,
                "--quiet",
            ]);
            if (!installed) {
                vscode.window.showErrorMessage("LLM Sandbox: Failed to install Python dependencies. Check the Output panel.");
                return false;
            }
            // Write marker
            fs.writeFileSync(markerPath, new Date().toISOString());
            this.outputChannel.appendLine("Dependencies installed.");
        }
        return true;
    }
    runCommand(cmd, args) {
        return new Promise((resolve) => {
            const proc = (0, child_process_1.spawn)(cmd, args, { cwd: this.extensionPath });
            proc.stdout?.on("data", (data) => {
                this.outputChannel.append(data.toString());
            });
            proc.stderr?.on("data", (data) => {
                this.outputChannel.append(data.toString());
            });
            proc.on("exit", (code) => {
                resolve(code === 0);
            });
            proc.on("error", (err) => {
                this.outputChannel.appendLine(`Command error: ${err.message}`);
                resolve(false);
            });
        });
    }
    dispose() {
        this.stop();
        this.outputChannel.dispose();
        this.statusBar.dispose();
    }
}
exports.ServerManager = ServerManager;
//# sourceMappingURL=serverManager.js.map