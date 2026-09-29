'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  HardDrive,
  Download,
  Trash2,
  RefreshCw,
  Calendar,
  FileArchive,
  AlertCircle,
  CheckCircle,
  Clock,
  RotateCcw,
  Loader2,
} from 'lucide-react';
import { BackupInfo, BCContainer } from '@/lib/types';
import {
  listBackups,
  createBackup,
  deleteBackup,
  restoreBackup,
  listContainers,
} from '@/lib/electron-api';

export default function BackupsPage() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [containers, setContainers] = useState<BCContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingBackup, setCreatingBackup] = useState<string | null>(null);
  const [deletingBackup, setDeletingBackup] = useState<string | null>(null);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);

  // State is only set from promise callbacks, never synchronously, so the
  // mount effect below doesn't trigger a cascading render
  // (react-hooks/set-state-in-effect).
  const fetchBackups = useCallback(() =>
    listBackups()
      .then((data) => {
        setBackups(data);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to fetch backups');
      })
      .finally(() => {
        setLoading(false);
      }), []);

  const fetchContainers = useCallback(() =>
    listContainers()
      .then((data) => {
        setContainers(data.filter((c: BCContainer) => c.status === 'running'));
      })
      .catch((err) => {
        console.error('Failed to fetch containers:', err);
      }), []);

  useEffect(() => {
    fetchBackups();
    fetchContainers();
  }, [fetchBackups, fetchContainers]);

  const handleCreateBackup = useCallback(async (containerId: string) => {
    setCreatingBackup(containerId);
    try {
      await createBackup(containerId);
      toast.success('Backup created successfully!');
      await fetchBackups();
    } catch (err) {
      toast.error(`Backup failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setCreatingBackup(null);
    }
  }, [fetchBackups]);

  const handleDeleteBackup = useCallback(async (backup: BackupInfo) => {
    if (!confirm(`Delete backup ${backup.fileName}?`)) return;

    setDeletingBackup(backup.id);
    try {
      await deleteBackup(backup.filePath);
      toast.success('Backup deleted successfully');
      await fetchBackups();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeletingBackup(null);
    }
  }, [fetchBackups]);

  const handleRestoreBackup = useCallback(async (backup: BackupInfo) => {
    if (!confirm(`Restore container "${backup.containerName}" from backup "${backup.fileName}"?\n\nThis will replace the current database. The container will be restarted.`)) {
      return;
    }

    setRestoringBackup(backup.id);
    try {
      // Use backupFolder if available (timestamped directory), otherwise use filePath
      const backupPath = backup.backupFolder || backup.filePath;
      await restoreBackup(backupPath, backup.containerName);
      toast.success('Container restored successfully!');
    } catch (err) {
      toast.error(`Restore failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRestoringBackup(null);
    }
  }, []);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Group backups by container
  const groupedBackups = backups.reduce((acc, backup) => {
    if (!acc[backup.containerName]) {
      acc[backup.containerName] = [];
    }
    acc[backup.containerName].push(backup);
    return acc;
  }, {} as Record<string, BackupInfo[]>);

  const totalSize = backups.reduce((sum, b) => sum + b.size, 0);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Backups</h1>
          <p className="text-gray-400">Manage your Business Central database backups</p>
        </div>
        <button
          onClick={fetchBackups}
          disabled={loading}
          className="btn btn-secondary flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-500/20 rounded-lg flex items-center justify-center">
              <FileArchive className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{backups.length}</p>
              <p className="text-sm text-gray-400">Total Backups</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-500/20 rounded-lg flex items-center justify-center">
              <HardDrive className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{formatFileSize(totalSize)}</p>
              <p className="text-sm text-gray-400">Total Size</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-500/20 rounded-lg flex items-center justify-center">
              <Calendar className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">
                {backups.length > 0 ? formatDate(backups[0].createdAt).split(',')[0] : '-'}
              </p>
              <p className="text-sm text-gray-400">Latest Backup</p>
            </div>
          </div>
        </div>
      </div>

      {/* Create Backup Section */}
      {containers.length > 0 && (
        <div className="card mb-6">
          <h3 className="card-title mb-4">Create New Backup</h3>
          <div className="flex flex-wrap gap-3">
            {containers.map((container) => (
              <button
                key={container.id}
                onClick={() => handleCreateBackup(container.id)}
                disabled={creatingBackup !== null}
                className="btn btn-primary flex items-center gap-2"
              >
                {creatingBackup === container.id ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Backup {container.name}
                  </>
                )}
              </button>
            ))}
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
      {loading && backups.length === 0 && (
        <div className="text-center py-12">
          <RefreshCw className="w-8 h-8 animate-spin text-gray-400 mx-auto mb-4" />
          <p className="text-gray-400">Loading backups...</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && backups.length === 0 && !error && (
        <div className="card text-center py-12">
          <FileArchive className="w-12 h-12 text-gray-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">No Backups Found</h3>
          <p className="text-gray-400 mb-4">
            Create your first backup using the buttons above or from a container detail page.
          </p>
        </div>
      )}

      {/* Backup List by Container */}
      {Object.entries(groupedBackups).map(([containerName, containerBackups]) => {
        // Find if this container is currently running (to enable backup button)
        const runningContainer = containers.find(c => c.name === containerName);

        return (
        <div key={containerName} className="card mb-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="card-title flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-blue-400" />
              {containerName}
              <span className="text-sm font-normal text-gray-400">
                ({containerBackups.length} backup{containerBackups.length !== 1 ? 's' : ''})
              </span>
            </h3>
            {runningContainer && (
              <button
                onClick={() => handleCreateBackup(runningContainer.id)}
                disabled={creatingBackup !== null}
                className="btn btn-primary btn-sm flex items-center gap-2"
                title="Create new backup for this container"
              >
                {creatingBackup === runningContainer.id ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Backup Now
                  </>
                )}
              </button>
            )}
          </div>

          <div className="space-y-2">
            {containerBackups.map((backup) => (
              <div
                key={backup.id}
                className="flex items-center justify-between p-3 bg-gray-700/50 rounded-lg"
              >
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    {backup.status === 'completed' ? (
                      <CheckCircle className="w-4 h-4 text-green-400" />
                    ) : backup.status === 'in_progress' ? (
                      <Clock className="w-4 h-4 text-yellow-400 animate-pulse" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-red-400" />
                    )}
                    <span className="font-medium text-white">{backup.fileName}</span>
                  </div>
                  <span className="text-sm text-gray-400">{formatFileSize(backup.size)}</span>
                  <span className="text-sm text-gray-500">{formatDate(backup.createdAt)}</span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleRestoreBackup(backup)}
                    disabled={restoringBackup !== null || deletingBackup !== null || creatingBackup !== null}
                    className="btn btn-ghost text-green-400 hover:text-green-300 hover:bg-green-500/10 p-2"
                    title="Restore from this backup"
                  >
                    {restoringBackup === backup.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RotateCcw className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => handleDeleteBackup(backup)}
                    disabled={deletingBackup === backup.id || restoringBackup !== null}
                    className="btn btn-ghost text-red-400 hover:text-red-300 hover:bg-red-500/10 p-2"
                    title="Delete backup"
                  >
                    {deletingBackup === backup.id ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        );
      })}
    </div>
  );
}
