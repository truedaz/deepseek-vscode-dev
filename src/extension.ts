import * as vscode from 'vscode';
import * as path from 'path';
import * as https from 'https';
import { promises as fs } from 'fs';

export function activate(context: vscode.ExtensionContext) {
  // Register the webview view provider
  const provider = new DeepseekChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('deepseekChatView', provider)
  );

  // Register the command to open chat
  let openChatCommand = vscode.commands.registerCommand('deepseek.openChat', () => {
    vscode.commands.executeCommand('deepseekChatView.focus');
  });

  context.subscriptions.push(openChatCommand);
}

class DeepseekChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _conversationHistory: any[] = [];
  private _isProcessing: boolean = false;
  private _selectedModel: string = 'deepseek-chat';

  constructor(private readonly _extensionUri: vscode.Uri) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri
      ]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.type) {
        case 'sendMessage':
          this._handleMessage(data.value.message, data.value.model);
          return;
        case 'webviewReady':
          this._restoreConversation();
          this._sendAvailableModels();
          return;
      }
    });
  }

  private _sendAvailableModels() {
    if (!this._view) return;

    this._safePostMessage({
      type: 'setModels',
      value: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-coder', name: 'DeepSeek Coder' }
      ]
    });
  }

  private _restoreConversation() {
    if (!this._view) return;

    // Send all previous messages to the webview
    this._conversationHistory.forEach(msg => {
      this._safePostMessage({
        type: 'addMessage',
        value: {
          text: msg.content,
          isUser: msg.role === 'user'
        }
      });
    });
  }

  public focusInput() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'focusInput' });
    }
  }

  private async _handleMessage(message: string, model: string) {
    if (!this._view || this._isProcessing) {
      return;
    }

    this._isProcessing = true;
    this._selectedModel = model;

    // Add user message to conversation history
    this._conversationHistory.push({ role: "user", content: message });

    try {
      // Get configuration
      const config = vscode.workspace.getConfiguration('deepseek');
      const apiKey = config.get<string>('apiKey');
      const endpoint = config.get<string>('endpoint') || 'https://api.deepseek.com/v1/chat/completions';
      const maxTokens = config.get<number>('maxResponseTokens') || 1024;
      const allowEditing = config.get<boolean>('allowEditing') || true;

      if (!apiKey) {
        this._safePostMessage({
          type: 'addMessage',
          value: {
            text: 'Error: Please set your DeepSeek API key in settings.',
            isUser: false
          }
        });
        this._isProcessing = false;
        return;
      }

      // Show typing indicator
      this._safePostMessage({
        type: 'setTypingIndicator',
        value: true
      });

      // Call DeepSeek API
      const response = await this._callDeepSeekAPI(
        endpoint,
        apiKey,
        model,
        this._conversationHistory,
        maxTokens
      );

      // Add assistant response to conversation history
      this._conversationHistory.push({ role: "assistant", content: response });

      // Hide typing indicator
      this._safePostMessage({
        type: 'setTypingIndicator',
        value: false
      });

      // Process the response for file creation/editing if allowed
      let createdFiles: string[] = [];
      if (allowEditing) {
        createdFiles = await this._processResponseForFiles(response);
      }

      // Show appropriate message in chat
      if (createdFiles.length > 0) {
        this._safePostMessage({
          type: 'addMessage',
          value: {
            text: `✅ Created ${createdFiles.length} file(s):\n${createdFiles.join('\n')}\n\n${response}`,
            isUser: false
          }
        });
      } else {
        this._safePostMessage({
          type: 'addMessage',
          value: {
            text: response,
            isUser: false
          }
        });
      }

    } catch (error) {
      // Hide typing indicator on error
      this._safePostMessage({
        type: 'setTypingIndicator',
        value: false
      });

      // Show error message
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._safePostMessage({
        type: 'addMessage',
        value: {
          text: `Error: ${errorMessage}`,
          isUser: false
        }
      });
    } finally {
      this._isProcessing = false;
    }
  }

  private async _processResponseForFiles(response: string): Promise<string[]> {
    // Look for code blocks in the response
    const codeBlocks = this._extractCodeBlocks(response);
    const createdFiles: string[] = [];

    if (codeBlocks.length === 0) {
      return createdFiles;
    }

    for (const block of codeBlocks) {
      const { language, code } = block;

      // Determine file extension based on language
      const extension = this._getFileExtension(language);

      // Create a file with the code
      const fileName = await this._createFile(code, extension);
      if (fileName) {
        createdFiles.push(fileName);
      }
    }

    return createdFiles;
  }

  private _extractCodeBlocks(response: string): { language: string, code: string }[] {
    const codeBlockRegex = /```(\w+)?\s*\n([\s\S]*?)\n```/g;
    const blocks = [];
    let match;

    while ((match = codeBlockRegex.exec(response)) !== null) {
      const language = match[1] || '';
      const code = match[2].trim();
      blocks.push({ language, code });
    }

    return blocks;
  }

  private _getFileExtension(language: string): string {
    const extensionMap: { [key: string]: string } = {
      'html': 'html',
      'javascript': 'js',
      'typescript': 'ts',
      'css': 'css',
      'python': 'py',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'php': 'php',
      'ruby': 'rb',
      'go': 'go',
      'rust': 'rs',
      'swift': 'swift',
      'kotlin': 'kt',
      'sql': 'sql',
      'json': 'json',
      'xml': 'xml',
      'markdown': 'md',
      'yaml': 'yml',
      'shell': 'sh'
    };

    return extensionMap[language.toLowerCase()] || 'txt';
  }

  private async _createFile(content: string, extension: string = 'txt'): Promise<string | null> {
    try {
      // Get the workspace folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }

      const workspacePath = workspaceFolders[0].uri.fsPath;

      // Generate a filename based on content or use a generic name
      let fileName = `generated_${Date.now()}.${extension}`;

      // Try to extract a better filename from content
      if (extension === 'html') {
        const titleMatch = content.match(/<title>(.*?)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
          fileName = `${titleMatch[1].replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}.${extension}`;
        }
      } else if (extension === 'py') {
        const funcMatch = content.match(/def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
        if (funcMatch && funcMatch[1]) {
          fileName = `${funcMatch[1]}.py`;
        }
      }

      const filePath = path.join(workspacePath, fileName);

      // Write the file
      await fs.writeFile(filePath, content);

      // Show the file in the editor
      const document = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(document);

      return fileName;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Error creating file: ${errorMessage}`);
      return null;
    }
  }

  private async _callDeepSeekAPI(
    endpoint: string,
    apiKey: string,
    model: string,
    messages: any[],
    maxTokens: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const requestData = JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0.7,
        stream: false
      });

      try {
        const url = new URL(endpoint);
        const options = {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(requestData)
          }
        };

        const req = https.request(options, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const response = JSON.parse(data);
                if (response.choices && response.choices.length > 0) {
                  resolve(response.choices[0].message.content);
                } else {
                  reject(new Error('No response from API'));
                }
              } catch (e) {
                reject(new Error('Failed to parse API response'));
              }
            } else if (res.statusCode === 401) {
              reject(new Error('Authentication failed. Please check your API key in settings.'));
            } else {
              // Try to parse error message from response
              try {
                const errorResponse = JSON.parse(data);
                reject(new Error(`API error: ${res.statusCode} - ${errorResponse.error?.message || data}`));
              } catch {
                reject(new Error(`API error: ${res.statusCode} - ${data}`));
              }
            }
          });
        });

        req.on('error', (error) => {
          reject(error);
        });

        req.write(requestData);
        req.end();
      } catch (error) {
        reject(new Error(`Invalid API endpoint: ${endpoint}`));
      }
    });
  }

  private _safePostMessage(message: any) {
    try {
      if (this._view && this._view.webview) {
        this._view.webview.postMessage(message);
      } else {
        console.warn('No webview available to send message to');
      }
    } catch (error) {
      console.error('Error posting message to webview:', error);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js');
    const scriptUri = webview.asWebviewUri(scriptPath);

    const stylePath = vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css');
    const styleUri = webview.asWebviewUri(stylePath);

    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link href="${styleUri}" rel="stylesheet">
          <title>DeepSeek Chat</title>
      </head>
      <body>
          <div class="chat-container">
              <div class="messages-container" id="messages">
                  <div class="message system-message">
                      Welcome to DeepSeek Chat! I can create and edit files in your workspace.
                  </div>
              </div>
              <div class="typing-indicator" id="typing-indicator" style="display: none;">
                  <span>DeepSeek is thinking...</span>
              </div>
              <div class="input-container">
                  <select id="model-selector" class="model-selector">
                      <option value="deepseek-chat">DeepSeek Chat</option>
                      <option value="deepseek-coder">DeepSeek Coder</option>
                  </select>
                  <input type="text" id="message-input" placeholder="Ask me to create or edit a file...">
                  <button id="send-button">Send</button>
              </div>
          </div>
          <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}