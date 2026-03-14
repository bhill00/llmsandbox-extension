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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const chatViewProvider_1 = require("./chatViewProvider");
const serverManager_1 = require("./serverManager");
let serverManager;
async function activate(context) {
    serverManager = new serverManager_1.ServerManager(context.extensionPath);
    const provider = new chatViewProvider_1.ChatViewProvider(context.extensionUri, serverManager);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("llmsandbox.chat", provider));
    context.subscriptions.push(vscode.commands.registerCommand("llmsandbox.resetConversation", () => {
        provider.resetConversation();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("llmsandbox.setModel", async () => {
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
    }));
    context.subscriptions.push(vscode.commands.registerCommand("llmsandbox.startServer", () => {
        serverManager.start();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("llmsandbox.stopServer", () => {
        serverManager.stop();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("llmsandbox.restartServer", () => {
        serverManager.restart();
    }));
    // Auto-start the server
    const config = vscode.workspace.getConfiguration("llmsandbox");
    if (config.get("apiUrl") && config.get("apiKey")) {
        serverManager.start();
    }
    else {
        vscode.window
            .showInformationMessage("LLM Sandbox: Configure your API URL and Key to get started.", "Open Settings")
            .then((action) => {
            if (action === "Open Settings") {
                vscode.commands.executeCommand("workbench.action.openSettings", "llmsandbox");
            }
        });
    }
}
function deactivate() {
    if (serverManager) {
        serverManager.dispose();
    }
}
//# sourceMappingURL=extension.js.map