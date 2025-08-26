import * as vscode from 'vscode';
import * as path from 'path';
import * as https from 'https';

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

  // Register the command to send message
  let sendMessageCommand = vscode.commands.registerCommand('deepseek.sendMessage', () => {
    provider.focusInput();
  });

  context.subscriptions.push(openChatCommand, sendMessageCommand);
}

class DeepseekChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _conversationHistory: any[] = [];

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
          this._handleMessage(data.value);
          return;
      }
    });
  }

  public focusInput() {
    if (this._view) {
      this._safePostMessage({ type: 'focusInput' });
    }
  }

  // Add this method to your DeepseekChatViewProvider class
  private async _testApiKey(apiKey: string, endpoint: string): Promise<boolean> {
    return new Promise((resolve) => {
      const testData = JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 5
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
            'Content-Length': Buffer.byteLength(testData)
          }
        };

        const req = https.request(options, (res) => {
          if (res.statusCode === 200) {
            resolve(true);
          } else {
            resolve(false);
          }
          res.resume(); // Drain response
        });

        req.on('error', () => {
          resolve(false);
        });

        req.write(testData);
        req.end();
      } catch {
        resolve(false);
      }
    });
  }

  private async _handleMessage(message: string) {
    if (!this._view) {
      vscode.window.showErrorMessage("Chat view is not available. Please try reopening the chat.");
      return;
    }

    // Add user message to conversation history
    this._conversationHistory.push({ role: "user", content: message });

    try {
      // Get configuration
      const config = vscode.workspace.getConfiguration('deepseek');
      const apiKey = config.get<string>('apiKey');
      const endpoint = config.get<string>('endpoint') || 'https://api.deepseek.com/v1/chat/completions';
      const model = config.get<string>('model') || 'deepseek-chat';
      const maxTokens = config.get<number>('maxResponseTokens') || 1024;

      if (!apiKey) {
        this._safePostMessage({
          type: 'addMessage',
          value: {
            text: 'Error: Please set your DeepSeek API key in settings.',
            isUser: false
          }
        });
        return;
      }

      // Test the API key
      const isValidKey = await this._testApiKey(apiKey, endpoint);
      if (!isValidKey) {
        this._safePostMessage({
          type: 'addMessage',
          value: {
            text: 'Error: Invalid API key. Please check your DeepSeek API key in settings.',
            isUser: false
          }
        });
        return;
      }

      // Show typing indicator
      this._safePostMessage({
        type: 'addTypingIndicator'
      });

      // Call DeepSeek API
      const response = await this._callDeepSeekAPI(
        endpoint,
        apiKey,
        model,
        this._conversationHistory,
        maxTokens
      );

      // Remove typing indicator
      this._safePostMessage({
        type: 'removeTypingIndicator'
      });

      // Add assistant response to conversation history
      this._conversationHistory.push({ role: "assistant", content: response });

      // Display the response
      this._safePostMessage({
        type: 'addMessage',
        value: {
          text: response,
          isUser: false
        }
      });

    } catch (error) {
      // Remove typing indicator
      this._safePostMessage({
        type: 'removeTypingIndicator'
      });

      // Show error message with proper error handling
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._safePostMessage({
        type: 'addMessage',
        value: {
          text: `Error: ${errorMessage}`,
          isUser: false
        }
      });
    }
  }

  // Helper method to safely post messages to the webview
  // In your DeepseekChatViewProvider class, replace the _safePostMessage method
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
                      Welcome to DeepSeek Chat! Start a conversation by typing below.
                  </div>
              </div>
              <div class="typing-indicator" id="typing-indicator" style="display: none;">
                  <span>DeepSeek is typing...</span>
              </div>
              <div class="input-container">
                  <input type="text" id="message-input" placeholder="Type your message here...">
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