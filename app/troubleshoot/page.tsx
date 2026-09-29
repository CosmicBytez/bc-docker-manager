'use client';

import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Container, AlertTriangle, Lightbulb, RefreshCw } from 'lucide-react';
import AIChat from '@/components/AIChat';
import { BCContainer } from '@/lib/types';
import { listContainers } from '@/lib/electron-api';

interface QuickAction {
  title: string;
  description: string;
  prompt: string;
  icon: React.ReactNode;
}

export default function TroubleshootPage() {
  const [containers, setContainers] = useState<BCContainer[]>([]);
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);

  const quickActions: QuickAction[] = [
    {
      title: 'Container Won\'t Start',
      description: 'Diagnose startup failures and port conflicts',
      prompt: 'My BC container won\'t start. What should I check?',
      icon: <AlertTriangle className="w-5 h-5 text-red-400" />,
    },
    {
      title: 'Performance Issues',
      description: 'Slow queries, high memory usage',
      prompt: 'My BC container is running slowly. How can I diagnose and fix performance issues?',
      icon: <RefreshCw className="w-5 h-5 text-yellow-400" />,
    },
    {
      title: 'License Problems',
      description: 'License activation and renewal',
      prompt: 'How do I update or renew the license in my BC container?',
      icon: <Container className="w-5 h-5 text-blue-400" />,
    },
    {
      title: 'Extension Errors',
      description: 'AL extension deployment failures',
      prompt: 'I\'m getting errors when publishing my AL extension. What are common causes?',
      icon: <Lightbulb className="w-5 h-5 text-purple-400" />,
    },
  ];

  // State is only set from promise callbacks, never synchronously, so the
  // mount effect below doesn't trigger a cascading render
  // (react-hooks/set-state-in-effect).
  const fetchContainers = useCallback(() =>
    listContainers()
      .then((data) => {
        setContainers(data);
        // Auto-select if only one container
        if (data.length === 1) {
          setSelectedContainer(data[0].name);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch containers:', err);
      })
      .finally(() => {
        setLoading(false);
      }), []);

  useEffect(() => {
    fetchContainers();
  }, [fetchContainers]);

  const handleQuickAction = (action: QuickAction) => {
    setInitialPrompt(action.prompt);
  };

  const selectedContainerData = containers.find(c => c.name === selectedContainer);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">AI Troubleshooting</h1>
        <p className="text-gray-400">Get help diagnosing and fixing Business Central container issues</p>
      </div>

      <div className="flex-1 grid grid-cols-3 gap-6 min-h-0">
        {/* Left Panel - Context & Quick Actions */}
        <div className="space-y-4">
          {/* Container Context */}
          <div className="card">
            <h3 className="card-title mb-3">Container Context</h3>
            <p className="text-sm text-gray-400 mb-3">
              Select a container to provide context for troubleshooting
            </p>

            {loading ? (
              <div className="flex items-center justify-center py-4">
                <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
              </div>
            ) : containers.length === 0 ? (
              <p className="text-sm text-gray-500">No containers found</p>
            ) : (
              <select
                value={selectedContainer || ''}
                onChange={(e) => setSelectedContainer(e.target.value || null)}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">General (no specific container)</option>
                {containers.map((container) => (
                  <option key={container.id} value={container.name}>
                    {container.name} ({container.status})
                  </option>
                ))}
              </select>
            )}

            {selectedContainerData && (
              <div className="mt-4 p-3 bg-gray-700/50 rounded-lg text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-gray-400">Status:</span>
                    <span className={`ml-2 ${
                      selectedContainerData.status === 'running' ? 'text-green-400' : 'text-gray-400'
                    }`}>
                      {selectedContainerData.status}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Version:</span>
                    <span className="ml-2 text-white">
                      {selectedContainerData.bcVersion || 'N/A'}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Health:</span>
                    <span className={`ml-2 ${
                      selectedContainerData.health === 'healthy' ? 'text-green-400' :
                      selectedContainerData.health === 'unhealthy' ? 'text-red-400' : 'text-gray-400'
                    }`}>
                      {selectedContainerData.health || 'N/A'}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Memory:</span>
                    <span className="ml-2 text-white">
                      {selectedContainerData.memoryUsage || 'N/A'}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="card">
            <h3 className="card-title mb-3">Quick Actions</h3>
            <div className="space-y-2">
              {quickActions.map((action, index) => (
                <button
                  key={index}
                  onClick={() => handleQuickAction(action)}
                  className="w-full flex items-start gap-3 p-3 bg-gray-700/50 hover:bg-gray-700 rounded-lg transition-colors text-left"
                >
                  <div className="mt-0.5">{action.icon}</div>
                  <div>
                    <p className="font-medium text-white">{action.title}</p>
                    <p className="text-sm text-gray-400">{action.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Tips */}
          <div className="card bg-blue-500/10 border-blue-500/30">
            <div className="flex items-start gap-3">
              <MessageSquare className="w-5 h-5 text-blue-400 mt-0.5" />
              <div>
                <h4 className="font-medium text-white mb-1">Tips</h4>
                <ul className="text-sm text-gray-300 space-y-1">
                  <li>• Paste error messages for specific help</li>
                  <li>• Include container logs when relevant</li>
                  <li>• Describe what you were doing when the issue occurred</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* Right Panel - Chat */}
        <div className="col-span-2 h-full">
          <AIChat
            initialContext={selectedContainer || undefined}
            initialPrompt={initialPrompt}
          />
        </div>
      </div>
    </div>
  );
}
