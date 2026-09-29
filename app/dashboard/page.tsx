'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { Container, Activity, HardDrive, AlertCircle, RefreshCw, GitCompare, X, Clock } from 'lucide-react';
import ContainerCard from '@/components/ContainerCard';
import ContainerComparison from '@/components/ContainerComparison';
import { BCContainer, DashboardStats } from '@/lib/types';
import { listContainers, containerAction, listBackups, getSetting } from '@/lib/electron-api';

async function loadDashboardData(): Promise<{ containers: BCContainer[]; stats: DashboardStats }> {
  const containers = await listContainers();

  const running = containers.filter((c: BCContainer) => c.status === 'running').length;
  const stopped = containers.filter((c: BCContainer) => c.status !== 'running').length;
  const healthy = containers.filter((c: BCContainer) => c.health === 'healthy').length;

  let backupCount = 0;
  try {
    const backups = await listBackups();
    backupCount = backups.length;
  } catch {
    // Ignore backup fetch errors for stats display
  }

  return {
    containers,
    stats: {
      totalContainers: containers.length,
      runningContainers: running,
      stoppedContainers: stopped,
      totalBackups: backupCount,
      healthyContainers: healthy,
      unhealthyContainers: containers.length - healthy,
    },
  };
}

export default function DashboardPage() {
  const [containers, setContainers] = useState<BCContainer[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [refreshInterval, setRefreshInterval] = useState(30000);
  const [selectedContainers, setSelectedContainers] = useState<string[]>([]);
  const [showComparison, setShowComparison] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load configurable refresh interval from settings
  useEffect(() => {
    const loadRefreshInterval = async () => {
      try {
        const interval = await getSetting<number>('autoRefreshInterval');
        if (interval && interval > 0) {
          setRefreshInterval(interval * 1000); // Settings stores seconds
        }
      } catch {
        // Use default 30s
      }
    };
    loadRefreshInterval();
  }, []);

  // State is only set from promise callbacks, never synchronously, so the
  // mount/interval effect below doesn't trigger a cascading render
  // (react-hooks/set-state-in-effect).
  const fetchContainers = useCallback(() =>
    loadDashboardData()
      .then(({ containers: data, stats: nextStats }) => {
        setContainers(data);
        setStats(nextStats);
        setLastRefreshed(new Date());
        setError(null);
      })
      .catch(() => {
        setError('Failed to connect to Docker. Is Docker running?');
      })
      .finally(() => {
        setLoading(false);
      }), []);

  // Auto-refresh with configurable interval and proper cleanup
  useEffect(() => {
    fetchContainers();

    // Clear any previous interval to prevent memory leaks
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = setInterval(fetchContainers, refreshInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchContainers, refreshInterval]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+R: Refresh containers
      if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        fetchContainers();
      }
      // Ctrl+N: Navigate to create container
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        window.location.href = '/create';
      }
      // Escape: Clear selection or close comparison
      if (e.key === 'Escape') {
        if (showComparison) {
          setShowComparison(false);
        } else if (selectedContainers.length > 0) {
          setSelectedContainers([]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fetchContainers, showComparison, selectedContainers]);

  const handleContainerAction = useCallback(async (action: 'start' | 'stop' | 'restart' | 'remove', containerId: string) => {
    try {
      await containerAction(containerId, action);
      // Refresh container list
      await fetchContainers();
    } catch (err) {
      toast.error(`Action failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [fetchContainers]);

  const handleContainerSelect = useCallback((containerId: string) => {
    setSelectedContainers(prev => {
      if (prev.includes(containerId)) {
        return prev.filter(id => id !== containerId);
      }
      // Max 2 selections for comparison
      if (prev.length >= 2) {
        return [prev[1], containerId];
      }
      return [...prev, containerId];
    });
  }, []);

  const comparedContainers = selectedContainers
    .map(id => containers.find(c => c.id === id))
    .filter((c): c is BCContainer => c !== undefined);

  const formatLastRefreshed = () => {
    if (!lastRefreshed) return '';
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - lastRefreshed.getTime()) / 1000);
    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    return `${diffMin}m ago`;
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">BC Containers</h1>
          <div className="flex items-center gap-3">
            <p className="text-gray-400">Manage your Business Central Docker containers</p>
            {lastRefreshed && (
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <Clock className="w-3 h-3" />
                Last refreshed {formatLastRefreshed()}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedContainers.length === 2 && (
            <button
              onClick={() => setShowComparison(true)}
              className="btn btn-primary flex items-center gap-2 animate-slide-in"
            >
              <GitCompare className="w-4 h-4" />
              Compare ({selectedContainers.length})
            </button>
          )}
          {selectedContainers.length > 0 && (
            <button
              onClick={() => setSelectedContainers([])}
              className="btn btn-ghost flex items-center gap-2"
            >
              <X className="w-4 h-4" />
              Clear
            </button>
          )}
          <button
            onClick={fetchContainers}
            disabled={loading}
            className="btn btn-secondary flex items-center gap-2"
            title="Refresh (Ctrl+R)"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-500/20 rounded-lg flex items-center justify-center">
                <Container className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{stats.totalContainers}</p>
                <p className="text-sm text-gray-400">Total Containers</p>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-green-500/20 rounded-lg flex items-center justify-center">
                <Activity className="w-5 h-5 text-green-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{stats.runningContainers}</p>
                <p className="text-sm text-gray-400">Running</p>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gray-500/20 rounded-lg flex items-center justify-center">
                <Container className="w-5 h-5 text-gray-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{stats.stoppedContainers}</p>
                <p className="text-sm text-gray-400">Stopped</p>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-500/20 rounded-lg flex items-center justify-center">
                <HardDrive className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{stats.totalBackups}</p>
                <p className="text-sm text-gray-400">Backups</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="card border-red-500/50 bg-red-500/10 mb-6">
          <div className="flex items-center gap-3 text-red-400">
            <AlertCircle className="w-5 h-5" />
            <p>{error}</p>
          </div>
        </div>
      )}

      {/* Loading State */}
      {loading && containers.length === 0 && (
        <div className="text-center py-12">
          <RefreshCw className="w-8 h-8 animate-spin text-gray-400 mx-auto mb-4" />
          <p className="text-gray-400">Loading containers...</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && containers.length === 0 && !error && (
        <div className="card text-center py-12">
          <Container className="w-12 h-12 text-gray-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">No BC Containers Found</h3>
          <p className="text-gray-400 mb-4">
            No containers with &quot;bc&quot; in the name were found.
          </p>
          <p className="text-sm text-gray-500">
            Create a container using the Create Container wizard or Deploy-BC-Container.ps1
          </p>
        </div>
      )}

      {/* Container Grid */}
      {containers.length > 0 && (
        <>
          {selectedContainers.length > 0 && selectedContainers.length < 2 && (
            <div className="mb-4 text-sm text-gray-400 animate-fade-in">
              Select one more container to compare side-by-side
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {containers.map((container) => (
              <ContainerCard
                key={container.id}
                container={container}
                onAction={handleContainerAction}
                selected={selectedContainers.includes(container.id)}
                onSelect={handleContainerSelect}
              />
            ))}
          </div>

          {/* Keyboard Shortcuts Hint */}
          <div className="mt-6 flex items-center justify-center gap-6 text-xs text-gray-600">
            <span><kbd className="kbd">Ctrl+R</kbd> Refresh</span>
            <span><kbd className="kbd">Ctrl+N</kbd> New Container</span>
            <span><kbd className="kbd">Esc</kbd> Clear Selection</span>
          </div>
        </>
      )}

      {/* Container Comparison Modal */}
      {showComparison && comparedContainers.length === 2 && (
        <ContainerComparison
          containerA={comparedContainers[0]}
          containerB={comparedContainers[1]}
          onClose={() => setShowComparison(false)}
        />
      )}
    </div>
  );
}
