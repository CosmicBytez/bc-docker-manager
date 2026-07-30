'use client';

import { useState, useEffect } from 'react';
import { toast } from 'react-hot-toast';
import {
  Box,
  CheckCircle,
  XCircle,
  Download,
  RefreshCw,
  ExternalLink,
  Loader2,
  Server,
  Cpu,
  HardDrive,
  Network,
  Shield,
} from 'lucide-react';
import { isElectron, openExternal, startDockerDesktop } from '@/lib/electron-api';

interface SetupStatus {
  docker: 'checking' | 'installed' | 'not_installed' | 'unknown' | 'error';
  dockerRunning: 'checking' | 'running' | 'stopped' | 'unknown' | 'error';
  bcContainerHelper: 'checking' | 'installed' | 'not_installed' | 'unknown' | 'error';
  hyperV: 'checking' | 'enabled' | 'disabled' | 'unknown' | 'error';
  wsl: 'checking' | 'installed' | 'not_installed' | 'unknown' | 'error';
}

interface SystemInfo {
  dockerVersion?: string;
  bcHelperVersion?: string;
  memoryGB?: number;
  containers?: number;
  images?: number;
}

export default function SetupPage() {
  const [isElectronApp] = useState(() => isElectron());
  const [status, setStatus] = useState<SetupStatus>({
    docker: 'checking',
    dockerRunning: 'checking',
    bcContainerHelper: 'checking',
    hyperV: 'checking',
    wsl: 'checking',
  });
  const [systemInfo, setSystemInfo] = useState<SystemInfo>({});
  const [isRefreshing, setIsRefreshing] = useState(false);

  const checkAllStatus = async () => {
    setIsRefreshing(true);

    // No dedicated probe script exists for BcContainerHelper / Hyper-V / WSL
    // yet, so any status we can't verify is reported as 'unknown' rather than
    // being fake-flipped to green.
    if (isElectron() && window.electronAPI) {
      try {
        const dockerResult = await window.electronAPI.docker.getDockerInfo();
        if (dockerResult.success && dockerResult.data) {
          setStatus(prev => ({
            ...prev,
            docker: 'installed',
            dockerRunning: 'running',
            bcContainerHelper: 'unknown',
            hyperV: 'unknown',
            wsl: 'unknown',
          }));
          setSystemInfo(prev => ({
            ...prev,
            dockerVersion: dockerResult.data?.version,
            containers: dockerResult.data?.containers,
            memoryGB: 0,
          }));
        } else {
          setStatus(prev => ({
            ...prev,
            docker: 'installed',
            dockerRunning: 'stopped',
            bcContainerHelper: 'unknown',
            hyperV: 'unknown',
            wsl: 'unknown',
          }));
          setSystemInfo(prev => ({ ...prev, memoryGB: 0 }));
        }
      } catch {
        setStatus(prev => ({
          ...prev,
          docker: 'error',
          dockerRunning: 'error',
          bcContainerHelper: 'unknown',
          hyperV: 'unknown',
          wsl: 'unknown',
        }));
        setSystemInfo(prev => ({ ...prev, memoryGB: 0 }));
      }
    } else {
      // Web mode - all backend APIs are stubs returning canned success with
      // no real environment signal, so nothing can be verified. Report every
      // status as 'unknown' rather than misleading the user.
      setStatus({
        docker: 'unknown',
        dockerRunning: 'unknown',
        bcContainerHelper: 'unknown',
        hyperV: 'unknown',
        wsl: 'unknown',
      });
      setSystemInfo(prev => ({ ...prev, memoryGB: 0 }));
    }

    setIsRefreshing(false);
  };

  // Initial status check on mount - calling async function that sets multiple states
  // This is a legitimate data-fetching pattern
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { checkAllStatus(); }, []);

  const handleInstallDocker = () => {
    openExternal('https://learn.microsoft.com/en-us/virtualization/windowscontainers/quick-start/set-up-environment');
    toast.success('Opening Windows Containers setup guide...');
  };

  const handleInstallBcHelper = async () => {
    if (!isElectronApp) {
      toast.error('PowerShell required - use desktop app');
      return;
    }

    toast.loading('Installing BcContainerHelper...', { id: 'bchelper' });

    try {
      const result = await window.electronAPI?.powershell.run('scripts/Install-BC-Helper.ps1', ['-InstallModuleOnly']);
      if (result?.exitCode === 0) {
        toast.success('BcContainerHelper installed!', { id: 'bchelper' });
        setStatus(prev => ({ ...prev, bcContainerHelper: 'installed' }));
      } else {
        const detail = (result?.stderr || result?.stdout || '').trim().split('\n').pop();
        toast.error(
          detail
            ? `Installation failed: ${detail}`
            : 'Installation failed. Run PowerShell as Admin.',
          { id: 'bchelper' }
        );
      }
    } catch {
      toast.error('Installation failed', { id: 'bchelper' });
    }
  };

  const handleStartDocker = async () => {
    if (!isElectronApp) {
      toast.error('Desktop app required');
      return;
    }

    toast.loading('Starting Docker Desktop...', { id: 'docker-start' });

    try {
      const result = await startDockerDesktop();
      if (!result.success) {
        toast.error(`Failed to start Docker: ${result.error ?? 'unknown error'}`, { id: 'docker-start' });
        return;
      }

      toast.success('Docker Desktop starting...', { id: 'docker-start' });

      // Check status after a delay
      setTimeout(checkAllStatus, 10000);
    } catch {
      toast.error('Failed to start Docker', { id: 'docker-start' });
    }
  };

  const getStatusIcon = (statusValue: string) => {
    switch (statusValue) {
      case 'installed':
      case 'running':
      case 'enabled':
        return <CheckCircle className="w-6 h-6 text-green-400" />;
      case 'not_installed':
      case 'stopped':
      case 'disabled':
        return <XCircle className="w-6 h-6 text-red-400" />;
      case 'checking':
        return <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />;
      case 'unknown':
        return <XCircle className="w-6 h-6 text-gray-400" />;
      default:
        return <XCircle className="w-6 h-6 text-yellow-400" />;
    }
  };

  const getStatusText = (statusValue: string) => {
    switch (statusValue) {
      case 'installed':
        return 'Installed';
      case 'not_installed':
        return 'Not Installed';
      case 'running':
        return 'Running';
      case 'stopped':
        return 'Stopped';
      case 'enabled':
        return 'Enabled';
      case 'disabled':
        return 'Disabled';
      case 'checking':
        return 'Checking...';
      case 'unknown':
        return 'Unknown';
      default:
        return 'Unknown';
    }
  };

  const getStatusColor = (statusValue: string) => {
    switch (statusValue) {
      case 'installed':
      case 'running':
      case 'enabled':
        return 'text-green-400';
      case 'not_installed':
      case 'stopped':
      case 'disabled':
        return 'text-red-400';
      case 'checking':
        return 'text-blue-400';
      case 'unknown':
        return 'text-gray-400';
      default:
        return 'text-yellow-400';
    }
  };

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Box className="w-8 h-8" />
            Docker Setup
          </h1>
          <p className="text-gray-400 mt-2">
            Check and configure prerequisites for BC containers
          </p>
        </div>
        <button
          onClick={checkAllStatus}
          disabled={isRefreshing}
          className="btn-secondary flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refresh Status
        </button>
      </div>

      {/* Status Tiles Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {/* Docker Engine Tile */}
        <div className="card p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="p-3 bg-blue-500/20 rounded-lg">
              <Server className="w-6 h-6 text-blue-400" />
            </div>
            {getStatusIcon(status.docker)}
          </div>
          <h3 className="text-lg font-semibold mb-1">Docker Engine</h3>
          <p className={`text-sm ${getStatusColor(status.docker)}`}>
            {getStatusText(status.docker)}
          </p>
          {systemInfo.dockerVersion && (
            <p className="text-xs text-gray-500 mt-1">v{systemInfo.dockerVersion}</p>
          )}
          <p className="text-xs text-gray-500 mt-1">Windows Containers</p>
          {status.docker === 'not_installed' && (
            <button
              onClick={handleInstallDocker}
              className="mt-4 w-full btn-primary flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              Install Docker
            </button>
          )}
        </div>

        {/* Docker Running Tile */}
        <div className="card p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="p-3 bg-green-500/20 rounded-lg">
              <Cpu className="w-6 h-6 text-green-400" />
            </div>
            {getStatusIcon(status.dockerRunning)}
          </div>
          <h3 className="text-lg font-semibold mb-1">Docker Engine</h3>
          <p className={`text-sm ${getStatusColor(status.dockerRunning)}`}>
            {getStatusText(status.dockerRunning)}
          </p>
          {systemInfo.containers !== undefined && (
            <p className="text-xs text-gray-500 mt-1">{systemInfo.containers} containers</p>
          )}
          {status.dockerRunning === 'stopped' && status.docker === 'installed' && (
            <button
              onClick={handleStartDocker}
              className="mt-4 w-full btn-primary flex items-center justify-center gap-2"
            >
              <Cpu className="w-4 h-4" />
              Start Docker
            </button>
          )}
        </div>

        {/* BcContainerHelper Tile */}
        <div className="card p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="p-3 bg-purple-500/20 rounded-lg">
              <HardDrive className="w-6 h-6 text-purple-400" />
            </div>
            {getStatusIcon(status.bcContainerHelper)}
          </div>
          <h3 className="text-lg font-semibold mb-1">BcContainerHelper</h3>
          <p className={`text-sm ${getStatusColor(status.bcContainerHelper)}`}>
            {getStatusText(status.bcContainerHelper)}
          </p>
          {systemInfo.bcHelperVersion && (
            <p className="text-xs text-gray-500 mt-1">v{systemInfo.bcHelperVersion}</p>
          )}
          {/* No probe can distinguish installed from missing yet, so the
              action is offered whenever the state is unknown — the script's
              module-only mode is idempotent (installs, or imports and reports
              the version). Gating on 'not_installed' alone made this button
              unreachable: checkAllStatus never yields that value. */}
          {(status.bcContainerHelper === 'not_installed' ||
            status.bcContainerHelper === 'unknown') && (
            <button
              onClick={handleInstallBcHelper}
              className="mt-4 w-full btn-primary flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              Install Module
            </button>
          )}
        </div>

        {/* Hyper-V Tile */}
        <div className="card p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="p-3 bg-orange-500/20 rounded-lg">
              <Shield className="w-6 h-6 text-orange-400" />
            </div>
            {getStatusIcon(status.hyperV)}
          </div>
          <h3 className="text-lg font-semibold mb-1">Hyper-V</h3>
          <p className={`text-sm ${getStatusColor(status.hyperV)}`}>
            {getStatusText(status.hyperV)}
          </p>
          <p className="text-xs text-gray-500 mt-1">Required for BC containers</p>
          {status.hyperV === 'disabled' && (
            <button
              onClick={() => openExternal('https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/quick-start/enable-hyper-v')}
              className="mt-4 w-full btn-secondary flex items-center justify-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              How to Enable
            </button>
          )}
        </div>

        {/* WSL Tile */}
        <div className="card p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="p-3 bg-cyan-500/20 rounded-lg">
              <Network className="w-6 h-6 text-cyan-400" />
            </div>
            {getStatusIcon(status.wsl)}
          </div>
          <h3 className="text-lg font-semibold mb-1">WSL 2</h3>
          <p className={`text-sm ${getStatusColor(status.wsl)}`}>
            {getStatusText(status.wsl)}
          </p>
          <p className="text-xs text-gray-500 mt-1">Windows Subsystem for Linux</p>
          {status.wsl === 'not_installed' && (
            <button
              onClick={() => openExternal('https://learn.microsoft.com/en-us/windows/wsl/install')}
              className="mt-4 w-full btn-secondary flex items-center justify-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              Install Guide
            </button>
          )}
        </div>

        {/* System Memory Tile */}
        <div className="card p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="p-3 bg-pink-500/20 rounded-lg">
              <HardDrive className="w-6 h-6 text-pink-400" />
            </div>
            {systemInfo.memoryGB === undefined ? (
              <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
            ) : systemInfo.memoryGB >= 16 ? (
              <CheckCircle className="w-6 h-6 text-green-400" />
            ) : systemInfo.memoryGB > 0 ? (
              <XCircle className="w-6 h-6 text-yellow-400" />
            ) : (
              <XCircle className="w-6 h-6 text-gray-400" />
            )}
          </div>
          <h3 className="text-lg font-semibold mb-1">System Memory</h3>
          <p className={`text-sm ${
            systemInfo.memoryGB === undefined ? 'text-blue-400' :
            systemInfo.memoryGB >= 16 ? 'text-green-400' :
            systemInfo.memoryGB > 0 ? 'text-yellow-400' : 'text-gray-400'
          }`}>
            {systemInfo.memoryGB === undefined ? 'Checking...' :
             systemInfo.memoryGB > 0 ? `${systemInfo.memoryGB} GB` : 'Unknown'}
          </p>
          <p className="text-xs text-gray-500 mt-1">16 GB+ recommended</p>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="card p-6">
        <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
        <div className="flex flex-wrap gap-4">
          <button
            onClick={() => openExternal('https://learn.microsoft.com/en-us/virtualization/windowscontainers/')}
            className="btn-secondary flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Windows Containers Docs
          </button>
          <button
            onClick={() => openExternal('https://freddysblog.com/category/bc-in-docker/')}
            className="btn-secondary flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            BC Container Guide
          </button>
          <button
            onClick={() => openExternal('https://github.com/microsoft/navcontainerhelper')}
            className="btn-secondary flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            BcContainerHelper GitHub
          </button>
        </div>
      </div>
    </div>
  );
}
