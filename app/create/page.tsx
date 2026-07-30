'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { toast } from 'react-hot-toast';
import {
  PlusCircle,
  Play,
  Terminal,
  CheckCircle,
  XCircle,
  Loader2,
  Info,
  ChevronDown,
} from 'lucide-react';
import {
  isElectron,
  runPowerShell,
  runPowerShellWithPassword,
} from '@/lib/electron-api';
import { useDeployment } from '@/lib/deployment-context';
import { detectHNSError, HNSError } from '@/lib/hns-error-detector';
import HNSErrorRecovery from '@/components/HNSErrorRecovery';
import NetworkDiagnostics from '@/components/NetworkDiagnostics';

// BC Version options matching Install-BC-Helper.ps1.
// Wave labels follow Microsoft's release calendar: W1 = April, W2 = October.
const BC_VERSIONS = [
  { value: 'Latest', label: 'Latest', description: 'Most recent stable release' },
  { value: 'NextMinor', label: 'Next Minor', description: 'Preview of next minor version' },
  { value: 'NextMajor', label: 'Next Major', description: 'Preview of next major version' },
  { value: '28', label: 'BC 28 (2026 W1)', description: '2026 Wave 1 — Current' },
  { value: '27', label: 'BC 27 (2025 W2)', description: '2025 Wave 2' },
  { value: '26', label: 'BC 26 (2025 W1)', description: '2025 Wave 1' },
  { value: '25', label: 'BC 25 (2024 W2)', description: '2024 Wave 2 — LTS' },
  { value: '24', label: 'BC 24 (2024 W1)', description: '2024 Wave 1' },
  { value: '23', label: 'BC 23 (2023 W2)', description: '2023 Wave 2' },
  { value: '22', label: 'BC 22 (2023 W1)', description: '2023 Wave 1' },
  { value: '21', label: 'BC 21 (2022 W2)', description: '2022 Wave 2' },
  { value: '20', label: 'BC 20 (2022 W1)', description: '2022 Wave 1' },
  { value: '19', label: 'BC 19', description: 'Older version' },
  { value: '18', label: 'BC 18', description: 'Older version' },
  { value: '17', label: 'BC 17', description: 'Older version' },
  { value: '16', label: 'BC 16', description: 'Older version' },
  { value: '15', label: 'BC 15', description: 'Older version' },
  { value: '14', label: 'BC 14', description: 'Older version - NAV 2019' },
  { value: '13', label: 'BC 13', description: 'Oldest supported' },
];

interface FormData {
  version: string;
  containerName: string;
  auth: 'Windows' | 'NavUserPassword';
  username: string;
  password: string;
  installTestToolkit: boolean;
  enableScheduledBackups: boolean;
}

export default function CreateContainerPage() {
  const [isElectronApp] = useState(() => isElectron());
  const [formData, setFormData] = useState<FormData>({
    version: 'Latest',
    containerName: '',
    auth: 'NavUserPassword',
    username: 'admin',
    password: '',
    installTestToolkit: true,
    enableScheduledBackups: true,
  });
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  // Use global deployment state
  const { deployment, startDeployment, addOutput, setStatus: setDeploymentStatus } = useDeployment();
  const status = deployment.status;
  const output = deployment.output;

  // Derive HNS error from deployment state (no need for separate state)
  const hnsError = useMemo<HNSError | null>(() => {
    if (status === 'error' && output.length > 0) {
      return detectHNSError(output);
    }
    return null;
  }, [status, output]);

  useEffect(() => {
    // Auto-scroll output
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const generateContainerName = (version: string): string => {
    const versionPart = version.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `bcserver-${versionPart}`;
  };

  const handleVersionChange = (version: string) => {
    setFormData((prev) => ({
      ...prev,
      version,
      containerName: prev.containerName || generateContainerName(version),
    }));
  };

  const handleDeploy = async () => {
    if (!formData.containerName) {
      toast.error('Please enter a container name');
      return;
    }

    if (formData.auth === 'NavUserPassword' && !formData.password) {
      toast.error('Please enter a password for NavUserPassword authentication');
      return;
    }

    // HNS error state is derived from deployment status via useMemo
    // It automatically clears when deployment status changes to 'running'

    // Start global deployment tracking
    startDeployment(formData.containerName, formData.version);

    try {
      // Build PowerShell command for deployment
      // Uses Deploy-BC-Container.ps1 (Docker-direct approach) which works on Windows 11 24H2
      // Install-BC-Helper.ps1 with New-BcContainer fails with HNS 0x803b0013 errors
      const scriptPath = 'scripts/Deploy-BC-Container.ps1';
      const args: string[] = [
        '-Version', formData.version,
        '-ContainerName', formData.containerName,
        '-Auth', formData.auth,
        '-Isolation', 'process',  // Process isolation avoids HNS port conflicts
      ];

      if (formData.auth === 'NavUserPassword') {
        args.push('-Username', formData.username);
      }

      if (formData.installTestToolkit) {
        args.push('-InstallTestToolkit');
      }

      if (formData.enableScheduledBackups) {
        args.push('-EnableScheduledBackups');
      }

      addOutput(`Executing: Deploy-BC-Container.ps1 ${args.join(' ')}`);
      addOutput('');

      // The password goes through a dedicated IPC path that stages it in a
      // mode-600 temp file; it is deliberately absent from `args` above so it
      // never reaches the command line or the deployment log.
      const result = formData.auth === 'NavUserPassword'
        ? await runPowerShellWithPassword(scriptPath, args, formData.password)
        : await runPowerShell(scriptPath, args);

      if (result.exitCode === 0) {
        setDeploymentStatus('success');
        addOutput('');
        addOutput('\u2713 Container deployed successfully!');
        toast.success('Container created successfully!');
      } else {
        setDeploymentStatus('error');
        addOutput('');
        addOutput(`\u2717 Deployment failed with exit code ${result.exitCode}`);
        if (result.stderr) addOutput(result.stderr);
        toast.error('Container deployment failed - check for network issues');
      }
    } catch (error) {
      setDeploymentStatus('error');
      addOutput('');
      addOutput(`\u2717 Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      toast.error('Container deployment failed');
    }
  };

  if (!isElectronApp) {
    return (
      <div className="p-8">
        <div className="card p-6 max-w-2xl">
          <div className="flex items-center gap-3 mb-4">
            <Info className="w-6 h-6 text-blue-400" />
            <h2 className="text-xl font-semibold">Desktop App Required</h2>
          </div>
          <p className="text-gray-400">
            Container creation requires PowerShell access and is only available
            in the desktop version of BC Container Manager.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <PlusCircle className="w-8 h-8" />
          Create BC Container
        </h1>
        <p className="text-gray-400 mt-2">
          Deploy a new Business Central Docker container
        </p>
      </div>

      {/* HNS Error Recovery Panel */}
      {hnsError && (
        <div className="mb-8">
          <HNSErrorRecovery
            error={hnsError}
            onRetry={handleDeploy}
            onDiagnosticsComplete={() => {
              setShowDiagnostics(true);
            }}
          />
        </div>
      )}

      {/* Network Diagnostics Panel (toggle) */}
      {showDiagnostics && (
        <div className="mb-8">
          <NetworkDiagnostics
            onComplete={() => {
              // Diagnostics complete - user can now retry
            }}
          />
        </div>
      )}

      {/* Diagnostics Toggle Button */}
      {!showDiagnostics && !hnsError && (
        <div className="mb-6">
          <button
            onClick={() => setShowDiagnostics(!showDiagnostics)}
            className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-2"
          >
            <Info className="w-4 h-4" />
            {showDiagnostics ? 'Hide' : 'Show'} Network Diagnostics
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Configuration Form */}
        <div className="space-y-6">
          {/* Version Selection */}
          <div className="card p-6">
            <h3 className="text-lg font-semibold mb-4">BC Version</h3>
            <div className="relative">
              <select
                value={formData.version}
                onChange={(e) => handleVersionChange(e.target.value)}
                disabled={status === 'running'}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3 appearance-none focus:outline-none focus:border-blue-500 cursor-pointer"
              >
                {BC_VERSIONS.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label} - {v.description}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none" />
            </div>
          </div>

          {/* Container Name */}
          <div className="card p-6">
            <h3 className="text-lg font-semibold mb-4">Container Name</h3>
            <input
              type="text"
              value={formData.containerName}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, containerName: e.target.value }))
              }
              placeholder="mybc-latest"
              disabled={status === 'running'}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-gray-500 mt-2">
              Name must contain &quot;bc&quot; for the dashboard to detect it (e.g., mybc-test, bcserver-latest)
            </p>
          </div>

          {/* Authentication */}
          <div className="card p-6">
            <h3 className="text-lg font-semibold mb-4">Authentication</h3>
            <div className="space-y-4">
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="auth"
                    value="NavUserPassword"
                    checked={formData.auth === 'NavUserPassword'}
                    onChange={() =>
                      setFormData((prev) => ({ ...prev, auth: 'NavUserPassword' }))
                    }
                    disabled={status === 'running'}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>NAV User/Password</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="auth"
                    value="Windows"
                    checked={formData.auth === 'Windows'}
                    onChange={() =>
                      setFormData((prev) => ({ ...prev, auth: 'Windows' }))
                    }
                    disabled={status === 'running'}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Windows Auth</span>
                </label>
              </div>

              {formData.auth === 'NavUserPassword' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Username</label>
                    <input
                      type="text"
                      value={formData.username}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, username: e.target.value }))
                      }
                      disabled={status === 'running'}
                      className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Password</label>
                    <input
                      type="password"
                      value={formData.password}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, password: e.target.value }))
                      }
                      disabled={status === 'running'}
                      className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Options */}
          <div className="card p-6">
            <h3 className="text-lg font-semibold mb-4">Options</h3>
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.installTestToolkit}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      installTestToolkit: e.target.checked,
                    }))
                  }
                  disabled={status === 'running'}
                  className="w-4 h-4 rounded text-blue-600"
                />
                <div>
                  <span className="font-medium">Install Test Toolkit</span>
                  <p className="text-xs text-gray-500">
                    Include AL test libraries and tools
                  </p>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.enableScheduledBackups}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      enableScheduledBackups: e.target.checked,
                    }))
                  }
                  disabled={status === 'running'}
                  className="w-4 h-4 rounded text-blue-600"
                />
                <div>
                  <span className="font-medium">Enable Scheduled Backups</span>
                  <p className="text-xs text-gray-500">
                    Daily backups at 02:00, 7-day retention
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Deploy Button */}
          <button
            onClick={handleDeploy}
            disabled={status === 'running'}
            className={`w-full py-4 rounded-lg font-semibold flex items-center justify-center gap-2 transition-colors ${
              status === 'running'
                ? 'bg-gray-600 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {status === 'running' ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Deploying...
              </>
            ) : status === 'success' ? (
              <>
                <CheckCircle className="w-5 h-5" />
                Deploy Another
              </>
            ) : status === 'error' ? (
              <>
                <XCircle className="w-5 h-5" />
                Retry Deployment
              </>
            ) : (
              <>
                <Play className="w-5 h-5" />
                Deploy Container
              </>
            )}
          </button>
        </div>

        {/* Output Console */}
        <div className="card p-6 flex flex-col h-[600px]">
          <div className="flex items-center gap-2 mb-4">
            <Terminal className="w-5 h-5 text-green-400" />
            <h3 className="text-lg font-semibold">Deployment Output</h3>
            {status === 'running' && (
              <Loader2 className="w-4 h-4 animate-spin text-blue-400 ml-auto" />
            )}
            {status === 'success' && (
              <CheckCircle className="w-4 h-4 text-green-400 ml-auto" />
            )}
            {status === 'error' && (
              <XCircle className="w-4 h-4 text-red-400 ml-auto" />
            )}
          </div>

          <div
            ref={outputRef}
            className="flex-1 bg-gray-900 rounded-lg p-4 font-mono text-sm overflow-auto"
          >
            {output.length === 0 ? (
              <span className="text-gray-500">
                Output will appear here when deployment starts...
              </span>
            ) : (
              output.map((line, i) => (
                <div
                  key={i}
                  className={`${
                    line.startsWith('\u2713')
                      ? 'text-green-400'
                      : line.startsWith('\u2717')
                      ? 'text-red-400'
                      : line.includes('WARNING')
                      ? 'text-yellow-400'
                      : 'text-gray-300'
                  }`}
                >
                  {line || '\u00A0'}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
