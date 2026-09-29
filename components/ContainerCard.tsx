'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Play,
  Square,
  RotateCcw,
  ExternalLink,
  MoreVertical,
  Trash2,
  HardDrive,
  Cpu,
  Clock,
} from 'lucide-react';
import { BCContainer } from '@/lib/types';

interface ContainerCardProps {
  container: BCContainer;
  onAction: (action: 'start' | 'stop' | 'restart' | 'remove', containerId: string) => Promise<void>;
  selected?: boolean;
  onSelect?: (containerId: string) => void;
}

export default function ContainerCard({ container, onAction, selected, onSelect }: ContainerCardProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [prevStatus, setPrevStatus] = useState(container.status);
  const [statusAnimating, setStatusAnimating] = useState(false);

  // Detect status changes during render rather than in an effect, so the
  // animation starts in the same render
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  if (container.status !== prevStatus) {
    setPrevStatus(container.status);
    setStatusAnimating(true);
  }

  // End the animation 1s after the latest status change
  useEffect(() => {
    if (!statusAnimating) return;
    const timer = setTimeout(() => setStatusAnimating(false), 1000);
    return () => clearTimeout(timer);
  }, [statusAnimating, prevStatus]);

  const handleAction = async (action: 'start' | 'stop' | 'restart' | 'remove') => {
    setLoading(action);
    setShowMenu(false);
    try {
      await onAction(action, container.id);
    } finally {
      setLoading(null);
    }
  };

  const statusClass = `status-${container.status}`;

  const statusDotColor = () => {
    switch (container.status) {
      case 'running': return 'bg-green-500';
      case 'restarting': return 'bg-yellow-500 animate-status-pulse';
      case 'paused': return 'bg-yellow-500';
      case 'exited':
      case 'dead': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  return (
    <div
      className={`card card-interactive ${selected ? 'border-blue-500 ring-1 ring-blue-500/30' : ''} ${statusAnimating ? 'animate-fade-in' : ''}`}
      onClick={() => onSelect?.(container.id)}
    >
      <div className="card-header">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full transition-colors duration-500 ${statusDotColor()}`} />
          <div>
            <h3 className="card-title">{container.name}</h3>
            <p className="text-sm text-gray-400">
              {container.bcVersion ? `BC ${container.bcVersion}` : container.image.split('/').pop()}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={`px-2 py-1 text-xs rounded border ${statusClass}`}>
            {container.status}
          </span>

          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="btn-ghost p-2 rounded-lg"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {showMenu && (
              <div className="absolute right-0 top-full mt-1 w-40 bg-gray-700 rounded-lg shadow-lg border border-gray-600 z-10">
                <button
                  onClick={() => handleAction('remove')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-red-400 hover:bg-gray-600 rounded-lg"
                >
                  <Trash2 className="w-4 h-4" />
                  Remove
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      {container.status === 'running' && (
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Cpu className="w-4 h-4" />
            <span>{container.cpuUsage || '0%'}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <HardDrive className="w-4 h-4" />
            <span>{container.memoryUsage || '0 B'}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Clock className="w-4 h-4" />
            <span>{container.uptime || '-'}</span>
          </div>
        </div>
      )}

      {/* Stats Error Indicator */}
      {container.statsError && (
        <div className="text-xs text-yellow-400 mb-2">
          Stats unavailable: {String(container.statsError)}
        </div>
      )}

      {/* Ports */}
      {container.ports.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-gray-500 mb-1">Ports</p>
          <div className="flex flex-wrap gap-2">
            {container.ports.slice(0, 3).map((port, i) => (
              <span key={i} className="text-xs bg-gray-700 px-2 py-1 rounded">
                {port.publicPort}:{port.privatePort}
              </span>
            ))}
            {container.ports.length > 3 && (
              <span className="text-xs text-gray-500">+{container.ports.length - 3} more</span>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {container.status === 'running' ? (
            <>
              <button
                onClick={() => handleAction('stop')}
                disabled={loading !== null}
                className="btn btn-secondary flex items-center gap-2"
              >
                <Square className="w-4 h-4" />
                {loading === 'stop' ? 'Stopping...' : 'Stop'}
              </button>
              <button
                onClick={() => handleAction('restart')}
                disabled={loading !== null}
                className="btn btn-ghost flex items-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                {loading === 'restart' ? 'Restarting...' : 'Restart'}
              </button>
            </>
          ) : (
            <button
              onClick={() => handleAction('start')}
              disabled={loading !== null}
              className="btn btn-success flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              {loading === 'start' ? 'Starting...' : 'Start'}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {container.webClientUrl && container.status === 'running' && (
            <a
              href={container.webClientUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost flex items-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              Open BC
            </a>
          )}
          <Link
            href={`/container?id=${container.id}`}
            className="btn btn-primary"
          >
            Details
          </Link>
        </div>
      </div>
    </div>
  );
}
