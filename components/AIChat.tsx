'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { AIMessage } from '@/lib/types';
import { sendAIMessage, isElectron, getSetting } from '@/lib/electron-api';

interface AIChatProps {
  initialContext?: string;
  initialPrompt?: string | null;
}

// Pre-canned responses for common issues when no API key is configured
const OFFLINE_RESPONSES: Record<string, string> = {
  "container won't start": `## Common Causes for Container Startup Failures

1. **Port Conflicts**
   - Check if ports 80, 443, 7046-7049 are already in use
   - Run: \`netstat -an | findstr :80\`
   - Solution: Stop conflicting services or use different ports

2. **HNS Networking Issues**
   - Windows NAT can have stale port reservations
   - Run as Admin: \`net stop hns && net start hns\`
   - Then restart Docker Desktop

3. **Insufficient Memory**
   - BC containers need 4-8GB RAM minimum
   - Check Docker Desktop settings for memory allocation

4. **Docker Not Running**
   - Ensure Docker Desktop is running
   - Check: \`docker info\`

5. **Image Pull Failures**
   - Verify internet connectivity
   - Check: \`docker pull mcr.microsoft.com/businesscentral\`

---
*For AI-powered assistance, add your Anthropic API key in Settings.*`,

  "performance": `## Diagnosing BC Container Performance Issues

1. **Check Memory Usage**
   - BC containers need 6-8GB for optimal performance
   - Increase Docker memory in Docker Desktop > Settings > Resources

2. **Database Optimization**
   - Run: \`Invoke-NavContainerCodeunit -containerName <name> -Codeunit 5500\`
   - This optimizes database indexes

3. **Service Tier Issues**
   - Check NST logs: \`Get-BcContainerEventLog -containerName <name>\`
   - Look for memory pressure or deadlock messages

4. **Hyper-V Isolation Overhead**
   - Consider using \`-isolation process\` if host and container OS match
   - This reduces overhead significantly

5. **Extension Count**
   - Too many extensions slow startup
   - Remove unused test extensions

---
*For AI-powered assistance, add your Anthropic API key in Settings.*`,

  "license": `## Managing BC Container Licenses

1. **Import a License File**
   \`\`\`powershell
   Import-BcContainerLicense -containerName <name> -licenseFile "C:\\path\\to\\license.flf"
   \`\`\`

2. **Check Current License**
   \`\`\`powershell
   Get-BcContainerLicenseInformation -containerName <name>
   \`\`\`

3. **Cronus Demo License**
   - Sandbox images include a demo license
   - Limited to 5 user sessions
   - Expires after evaluation period

4. **Developer License**
   - Request from PartnerSource/Microsoft
   - Upload via BC web client > Help > About

---
*For AI-powered assistance, add your Anthropic API key in Settings.*`,

  "extension": `## Troubleshooting AL Extension Deployment Errors

1. **Compilation Errors**
   - Check Output window in VS Code
   - Ensure all dependencies are listed in app.json

2. **Permission Errors**
   - Ensure you're using a Super user
   - Check \`User Card > Permissions\` in BC

3. **Package File Issues**
   \`\`\`powershell
   # Unpublish first if updating
   Unpublish-BcContainerApp -containerName <name> -appName "YourApp"

   # Then publish
   Publish-BcContainerApp -containerName <name> -appFile "C:\\path\\app.app" -skipVerification
   \`\`\`

4. **Synchronization Errors**
   - Use \`-syncMode ForceSync\` for dev containers
   - Never use ForceSync in production!

5. **Dependency Issues**
   - Check that base app version matches your app.json
   - Update dependencies: \`"application": ">=20.0.0.0"\`

---
*For AI-powered assistance, add your Anthropic API key in Settings.*`,
};

function getOfflineResponse(query: string): string {
  const lowerQuery = query.toLowerCase();

  if (lowerQuery.includes("won't start") || lowerQuery.includes("not start") || lowerQuery.includes("startup")) {
    return OFFLINE_RESPONSES["container won't start"];
  }
  if (lowerQuery.includes("slow") || lowerQuery.includes("performance") || lowerQuery.includes("memory")) {
    return OFFLINE_RESPONSES["performance"];
  }
  if (lowerQuery.includes("license") || lowerQuery.includes("renew")) {
    return OFFLINE_RESPONSES["license"];
  }
  if (lowerQuery.includes("extension") || lowerQuery.includes("publish") || lowerQuery.includes("al ")) {
    return OFFLINE_RESPONSES["extension"];
  }

  return `I can help with common BC container issues. Here are some topics I have documentation for:

- **Container startup failures** - port conflicts, HNS issues, memory problems
- **Performance issues** - slow queries, memory optimization
- **License management** - importing and checking licenses
- **Extension deployment** - publishing AL apps, sync errors

Try asking about one of these topics, or add your Anthropic API key in **Settings** for full AI-powered assistance.`;
}

export default function AIChat({ initialContext, initialPrompt }: AIChatProps) {
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasProcessedInitialPrompt = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Add welcome message on mount
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{
        id: 'welcome',
        role: 'assistant',
        content: `Hello! I'm your BC Docker troubleshooting assistant. I can help you with:

- **Container issues**: startup failures, crashes, performance problems
- **Configuration**: ports, memory, networking, SSL
- **Database**: backup/restore, SQL errors, data issues
- **Development**: extension deployment, debugging, web services

${initialContext ? `\nI see you're working with: ${initialContext}` : ''}

How can I help you today?`,
        timestamp: new Date().toISOString(),
      }]);
    }
  }, [initialContext, messages.length]);

  // Handle initial prompt from quick actions
  useEffect(() => {
    if (initialPrompt && !hasProcessedInitialPrompt.current && messages.length > 0) {
      hasProcessedInitialPrompt.current = true;
      // Set the input and auto-submit
      setInput(initialPrompt);
    }
  }, [initialPrompt, messages.length]);

  // Auto-submit when input is set from initialPrompt
  useEffect(() => {
    if (input && hasProcessedInitialPrompt.current && !loading) {
      // Small delay to ensure UI has updated
      const timer = setTimeout(() => {
        const form = document.querySelector('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
        hasProcessedInitialPrompt.current = false;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [input, loading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage: AIMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      // Check if we're in Electron mode and have an API key
      let responseContent: string;

      if (isElectron()) {
        // Use Electron IPC - this handles both online and offline modes
        try {
          const history = [...messages, userMessage]
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

          // The Messages API rejects a conversation that opens on an assistant
          // turn, and this transcript always starts with the welcome message.
          const firstUserIndex = history.findIndex(m => m.role === 'user');
          const chatMessages = firstUserIndex === -1 ? [] : history.slice(firstUserIndex);

          const result = await sendAIMessage(chatMessages);
          responseContent = result.content;
        } catch (err) {
          // Surface the real failure instead of passing keyword-matched docs
          // off as an answer.
          const detail = err instanceof Error ? err.message : 'Unknown error';
          responseContent = `**⚠️ Claude API request failed:** ${detail}\n\nShowing local documentation instead.\n\n---\n\n${getOfflineResponse(userMessage.content)}`;
        }
      } else {
        // Web mode - check for API key first
        const apiKey = await getSetting<string>('anthropicApiKey');

        if (!apiKey) {
          // No API key - use offline responses
          responseContent = getOfflineResponse(userMessage.content);
        } else {
          // Has API key - try API call
          const response = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [...messages, userMessage],
              context: initialContext,
            }),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data = await response.json();
          responseContent = data.message || getOfflineResponse(userMessage.content);
        }
      }

      const assistantMessage: AIMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: responseContent,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch {
      // Fallback to offline response on any error
      const offlineContent = getOfflineResponse(input.trim());
      setMessages((prev) => [...prev, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: offlineContent,
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setLoading(false);
    }
  };

  // Safely parse bold text without using dangerouslySetInnerHTML
  const parseBoldText = (text: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    const regex = /\*\*(.*?)\*\*/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      // Add text before the bold
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      // Add the bold text
      parts.push(<strong key={match.index}>{match[1]}</strong>);
      lastIndex = regex.lastIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    return parts.length > 0 ? parts : [text];
  };

  const formatMessage = (content: string) => {
    // Simple markdown-like formatting
    return content
      .split('\n')
      .map((line, i) => {
        // Headers
        if (line.startsWith('### ')) {
          return <h4 key={i} className="font-bold text-white mt-3 mb-1">{line.slice(4)}</h4>;
        }
        if (line.startsWith('## ')) {
          return <h3 key={i} className="font-bold text-white text-lg mt-4 mb-2">{line.slice(3)}</h3>;
        }

        // Code blocks
        if (line.startsWith('```')) {
          return null; // Handle separately
        }

        // Bullet points
        if (line.startsWith('- ')) {
          return (
            <li key={i} className="ml-4 list-disc">
              {parseBoldText(line.slice(2))}
            </li>
          );
        }

        // Numbered lists
        const numberedMatch = line.match(/^(\d+)\.\s/);
        if (numberedMatch) {
          return (
            <li key={i} className="ml-4 list-decimal">
              {parseBoldText(line.slice(numberedMatch[0].length))}
            </li>
          );
        }

        // Empty lines
        if (!line.trim()) {
          return <br key={i} />;
        }

        return <p key={i}>{parseBoldText(line)}</p>;
      });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : ''}`}
          >
            {message.role === 'assistant' && (
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                <Bot className="w-5 h-5 text-white" />
              </div>
            )}

            <div className={`chat-message ${message.role === 'user' ? 'chat-user' : 'chat-assistant'}`}>
              <div className="prose prose-invert prose-sm max-w-none">
                {formatMessage(message.content)}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {new Date(message.timestamp).toLocaleTimeString()}
              </p>
            </div>

            {message.role === 'user' && (
              <div className="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center shrink-0">
                <User className="w-5 h-5 text-white" />
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div className="chat-message chat-assistant">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-gray-700">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe your issue or ask a question..."
            className="input flex-1"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="btn btn-primary px-4"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Press Enter to send. Describe your issue in detail for better assistance.
        </p>
      </form>
    </div>
  );
}
