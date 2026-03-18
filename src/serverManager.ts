import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ChildProcess, spawn, execFile } from "child_process";

export type ServerState = "stopped" | "starting" | "running" | "error";

export class ServerManager {
  private process: ChildProcess | null = null;
  private state: ServerState = "stopped";
  private outputChannel: vscode.OutputChannel;
  private statusBar: vscode.StatusBarItem;
  private extensionPath: string;
  private onStateChange: ((state: ServerState) => void) | null = null;

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
    this.outputChannel = vscode.window.createOutputChannel("LLM Sandbox Server");
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBar.command = "llmsandbox.restartServer";
    this.statusBar.show();
    this.updateStatusBar();
  }

  setOnStateChange(cb: (state: ServerState) => void) {
    this.onStateChange = cb;
  }

  getState(): ServerState {
    return this.state;
  }

  getPort(): number {
    return vscode.workspace.getConfiguration("llmsandbox").get("serverPort", 8765);
  }

  private setState(state: ServerState) {
    this.state = state;
    this.updateStatusBar();
    this.onStateChange?.(state);
  }

  private updateStatusBar() {
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
        this.statusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        );
        break;
    }
  }

  async start(): Promise<boolean> {
    if (this.state === "running" || this.state === "starting") {
      return true;
    }

    // Validate settings
    const config = vscode.workspace.getConfiguration("llmsandbox");
    const apiUrl = config.get<string>("apiUrl", "");
    const apiKey = config.get<string>("apiKey", "");

    if (!apiUrl || !apiKey) {
      const action = await vscode.window.showErrorMessage(
        "LLM Sandbox: API URL and API Key must be configured.",
        "Open Settings"
      );
      if (action === "Open Settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "llmsandbox"
        );
      }
      this.setState("error");
      return false;
    }

    const pythonPath = config.get<string>("pythonPath", "python3");
    const port = config.get<number>("serverPort", 8765);
    const contextBudget = config.get<number>("contextBudget", 20000);
    const contextStrategy = config.get<string>("contextStrategy", "summary");
    const recentTurnsToKeep = config.get<number>("recentTurnsToKeep", 6);
    const enableReasoning = config.get<boolean>("enableReasoning", false);
    const autoIncludeActiveFile = config.get<boolean>("autoIncludeActiveFile", true);
    const systemPrompt = config.get<string>("systemPrompt", "");
    const pollTimeout = config.get<number>("pollTimeout", 30);

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

    this.process = spawn(
      venvPython,
      ["-m", "uvicorn", "server:app", "--port", String(port), "--host", "127.0.0.1"],
      {
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
          POLL_TIMEOUT: String(pollTimeout),
        },
      }
    );

    this.process.stdout?.on("data", (data: Buffer) => {
      this.outputChannel.append(data.toString());
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.outputChannel.append(text);
      if (
        text.includes("Application startup complete") ||
        text.includes("Uvicorn running on")
      ) {
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
    const currentState: string = this.state;
    if (!ok && currentState === "starting") {
      this.outputChannel.appendLine("Server did not become ready in time.");
      this.setState("error");
      return false;
    }

    return currentState === "running";
  }

  async stop(): Promise<void> {
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
        spawn("taskkill", ["/pid", String(pid), "/f", "/t"]);
      }
    } else {
      this.process.kill("SIGTERM");
    }

    // Give it a moment, then force kill
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          try { this.process.kill("SIGKILL"); } catch { /* already dead */ }
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

  async restart(): Promise<boolean> {
    await this.stop();
    return this.start();
  }

  private async waitForReady(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/status`);
        if (resp.ok) {
          this.setState("running");
          return true;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private getVenvPath(): string {
    return path.join(this.extensionPath, ".venv");
  }

  private getVenvPython(): string {
    const venvPath = this.getVenvPath();
    if (process.platform === "win32") {
      return path.join(venvPath, "Scripts", "python.exe");
    }
    return path.join(venvPath, "bin", "python");
  }

  private async ensureDependencies(pythonPath: string): Promise<boolean> {
    const venvPath = this.getVenvPath();
    const venvPython = this.getVenvPython();

    // Check if venv exists
    if (!fs.existsSync(venvPython)) {
      this.outputChannel.appendLine("Creating Python virtual environment...");

      const created = await this.runCommand(pythonPath, ["-m", "venv", venvPath]);
      if (!created) {
        vscode.window.showErrorMessage(
          "LLM Sandbox: Failed to create Python venv. Check the Output panel."
        );
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
        vscode.window.showErrorMessage(
          "LLM Sandbox: Failed to install Python dependencies. Check the Output panel."
        );
        return false;
      }
      // Write marker
      fs.writeFileSync(markerPath, new Date().toISOString());
      this.outputChannel.appendLine("Dependencies installed.");
    }

    return true;
  }

  private runCommand(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { cwd: this.extensionPath });

      proc.stdout?.on("data", (data: Buffer) => {
        this.outputChannel.append(data.toString());
      });

      proc.stderr?.on("data", (data: Buffer) => {
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
