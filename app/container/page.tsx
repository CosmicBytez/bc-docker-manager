'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import Link from 'next/link';
import {
  ArrowLeft,
  Play,
  Square,
  RotateCcw,
  ExternalLink,
  HardDrive,
  Download,
  Cpu,
  Clock,
  Network,
  Globe,
} from 'lucide-react';
import LogViewer from '@/components/LogViewer';
import { BCContainer, ContainerLog, ContainerStats } from '@/lib/types';
import {
  listContainers,
  getContainerStats,
  getContainerLogs,
  containerAction,
  createBackup,
  openExternal,
} from '@/lib/electron-api';

function findContainer(containers: BCContainer[], id: string): BCContainer | null {
  return containers.find((c) => c.id === id || c.id.startsWith(id)) ?? null;
}

function ContainerDetailContent() {
  const searchParams = useSearchParams();
  const containerId = searchParams.get('id');

  const [container, setContainer] = useState<BCContainer | null>(null);
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [logs, setLogs] = useState<ContainerLog[]>([]);
  // Nothing to load without an id, so start out loading only when there is one
  // (setting it false from the effect would be a cascading render).
  const [loading, setLoading] = useState(containerId !== null);
  const [logsLoading, setLogsLoading] = useState(containerId !== null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchContainer = async () => {
    if (!containerId) return;

    try {
      // Use electron-api functions instead of direct fetch
      const containers = await listContainers();
      setContainer(findContainer(containers, containerId));
    } catch (err) {
      console.error('Failed to fetch container:', err);
    }
  };

  const fetchLogs = async () => {
    if (!containerId) return;

    setLogsLoading(true);
    try {
      // Use electron-api functions instead of direct fetch
      const logsData = await getContainerLogs(containerId, { tail: 200 });
      setLogs(logsData);
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    } finally {
      setLogsLoading(false);
    }
  };

  // Load the container and its logs whenever the id changes. State is set only
  // from promise callbacks, and `ignore` drops responses for a stale id.
  useEffect(() => {
    if (!containerId) return;
    let ignore = false;

    listContainers()
      .then((containers) => {
        if (!ignore) setContainer(findContainer(containers, containerId));
      })
      .catch((err) => console.error('Failed to fetch container:', err))
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    getContainerLogs(containerId, { tail: 200 })
      .then((logsData) => {
        if (!ignore) setLogs(logsData);
      })
      .catch((err) => console.error('Failed to fetch logs:', err))
      .finally(() => {
        if (!ignore) setLogsLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [containerId]);

  // Poll stats every 10 seconds while the container is running
  const isRunning = container?.status === 'running';
  useEffect(() => {
    if (!containerId || !isRunning) return;
    let ignore = false;

    const pollStats = () => {
      getContainerStats(containerId)
        .then((containerStats) => {
          if (!ignore) setStats(containerStats);
        })
        .catch((err) => console.error('Failed to fetch stats:', err));
    };

    pollStats();
    const interval = setInterval(pollStats, 10000);
    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, [containerId, isRunning]);

  const handleAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!containerId) return;
    setActionLoading(action);
    try {
      // Use electron-api functions instead of direct fetch
      await containerAction(containerId, action);
      toast.success(`Container ${action} successful`);
      await fetchContainer();
      if (action === 'start') {
        setTimeout(fetchLogs, 2000);
      }
    } catch (err) {
      toast.error(`Action failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleBackup = async () => {
    if (!containerId) return;
    setActionLoading('backup');
    try {
      // Use electron-api functions instead of direct fetch
      await createBackup(containerId);
      toast.success('Backup created successfully!');
    } catch (err) {
      toast.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  // Get display values from stats or container
  const cpuDisplay = stats?.cpuPercent !== undefined
    ? `${stats.cpuPercent.toFixed(1)}%`
    : container?.cpuUsage || '-';
  const memoryDisplay = stats?.memoryUsage !== undefined
    ? formatBytes(stats.memoryUsage)
    : container?.memoryUsage || '-';
  const uptimeDisplay = container?.uptime || '-';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
      </div>
    );
  }

  if (!containerId) {
    return (
      <div className="card text-center py-12">
        <h2 className="text-xl font-bold text-white mb-2">No Container Selected</h2>
        <p className="text-gray-400 mb-4">Please select a container from the dashboard.</p>
        <Link href="/dashboard" className="btn btn-primary">
          Go to Dashboard
        </Link>
      </div>
    );
  }

  if (!container) {
    return (
      <div className="card text-center py-12">
        <h2 className="text-xl font-bold text-white mb-2">Container Not Found</h2>
        <p className="text-gray-400 mb-4">The container you&apos;re looking for doesn&apos;t exist or has been removed.</p>
        <Link href="/dashboard" className="btn btn-primary">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const statusClass = `status-${container.status}`;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Link href="/dashboard" className="btn btn-ghost p-2">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">{container.name}</h1>
            <span className={`px-2 py-1 text-xs rounded border ${statusClass}`}>
              {container.status}
            </span>
          </div>
          <p className="text-gray-400">
            {container.bcVersion ? `BC ${container.bcVersion}` : container.image}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {container.status === 'running' ? (
            <>
              <button
                onClick={() => handleAction('stop')}
                disabled={actionLoading !== null}
                className="btn btn-secondary flex items-center gap-2"
              >
                <Square className="w-4 h-4" />
                {actionLoading === 'stop' ? 'Stopping...' : 'Stop'}
              </button>
              <button
                onClick={() => handleAction('restart')}
                disabled={actionLoading !== null}
                className="btn btn-ghost flex items-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                {actionLoading === 'restart' ? 'Restarting...' : 'Restart'}
              </button>
            </>
          ) : (
            <button
              onClick={() => handleAction('start')}
              disabled={actionLoading !== null}
              className="btn btn-success flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              {actionLoading === 'start' ? 'Starting...' : 'Start'}
            </button>
          )}

          <button
            onClick={handleBackup}
            disabled={actionLoading !== null || container.status !== 'running'}
            className="btn btn-primary flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            {actionLoading === 'backup' ? 'Creating...' : 'Backup'}
          </button>

          {container.webClientUrl && container.status === 'running' && (
            <a
              href={container.webClientUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary flex items-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              Open BC
            </a>
          )}
        </div>
      </div>

      {/* Web Client Button - Prominent */}
      {container.status === 'running' && container.ports.length > 0 && (
        <div className="card mb-6 bg-gradient-to-r from-blue-900/50 to-purple-900/50 border-blue-500/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Globe className="w-6 h-6 text-blue-400" />
              <div>
                <h3 className="font-semibold text-white">Business Central Web Client</h3>
                <p className="text-sm text-gray-400">
                  {container.webClientUrl || `http://localhost:${container.ports.find(p => p.privatePort === 80)?.publicPort || container.ports[0]?.publicPort}`}
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                const url = container.webClientUrl || `http://localhost:${container.ports.find(p => p.privatePort === 80)?.publicPort || container.ports[0]?.publicPort}/BC`;
                openExternal(url);
              }}
              className="btn btn-primary flex items-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              Open Web Client
            </button>
          </div>
        </div>
      )}

      {/* Info Grid */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="card">
          <div className="flex items-center gap-3">
            <Cpu className="w-5 h-5 text-blue-400" />
            <div>
              <p className="text-sm text-gray-400">CPU Usage</p>
              <p className="text-lg font-medium text-white">{cpuDisplay}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3">
            <HardDrive className="w-5 h-5 text-green-400" />
            <div>
              <p className="text-sm text-gray-400">Memory</p>
              <p className="text-lg font-medium text-white">{memoryDisplay}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3">
            <Clock className="w-5 h-5 text-yellow-400" />
            <div>
              <p className="text-sm text-gray-400">Uptime</p>
              <p className="text-lg font-medium text-white">{uptimeDisplay}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3">
            <Network className="w-5 h-5 text-purple-400" />
            <div>
              <p className="text-sm text-gray-400">Ports</p>
              <p className="text-lg font-medium text-white">{container.ports.length} mapped</p>
            </div>
          </div>
        </div>
      </div>

      {/* Port Mappings */}
      {container.ports.length > 0 && (
        <div className="card mb-6">
          <h3 className="card-title mb-4">Port Mappings</h3>
          <div className="grid grid-cols-4 gap-4">
            {container.ports.map((port, i) => (
              <div key={i} className="bg-gray-700 rounded-lg p-3">
                <p className="text-sm text-gray-400">Port {port.privatePort}</p>
                <p className="font-medium text-white">
                  localhost:{port.publicPort} → {port.privatePort}/{port.type}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Logs */}
      <div className="h-[600px]">
        <LogViewer
          logs={logs}
          onRefresh={fetchLogs}
          loading={logsLoading}
        />
      </div>
    </div>
  );
}

export default function ContainerDetailPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
      </div>
    }>
      <ContainerDetailContent />
    </Suspense>
  );
}
