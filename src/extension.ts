import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { ServerManager } from "./serverManager";

let serverManager: ServerManager;

export async function activate(context: vscode.ExtensionContext) {
  serverManager = new ServerManager(context.extensionPath);

  const provider = new ChatViewProvider(context.extensionUri, serverManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("llmsandbox.chat", provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("llmsandbox.resetConversation", () => {
      provider.resetConversation();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("llmsandbox.setModel", async () => {
      const models = [
        "claude-v4.5-sonnet",
        "claude-v4-sonnet",
        "claude-v3.5-sonnet",
      ];
      const picked = await vscode.window.showQuickPick(models, {
        placeHolder: "Select a model",
      });
      if (picked) {
        provider.setModel(picked);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("llmsandbox.startServer", () => {
      serverManager.start();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("llmsandbox.stopServer", () => {
      serverManager.stop();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("llmsandbox.restartServer", () => {
      serverManager.restart();
    })
  );

  // Auto-start the server
  const config = vscode.workspace.getConfiguration("llmsandbox");
  if (config.get<string>("apiUrl") && config.get<string>("apiKey")) {
    serverManager.start();
  } else {
    vscode.window
      .showInformationMessage(
        "LLM Sandbox: Configure your API URL and Key to get started.",
        "Open Settings"
      )
      .then((action) => {
        if (action === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "llmsandbox"
          );
        }
      });
  }
}

export function deactivate() {
  if (serverManager) {
    serverManager.dispose();
  }
}
