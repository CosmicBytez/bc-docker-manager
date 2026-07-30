/**
 * Call-site tests for the Setup page's "Start Docker" action.
 *
 * The bug lived here: the page called `powershell.run('cmd', [...])`, and since
 * 'cmd' is not in the main process's ALLOWED_SCRIPTS the handler resolved
 * `{ exitCode: 1 }` rather than rejecting — so the page reported "Docker
 * Desktop starting..." while nothing had started. Asserting on the
 * `startDockerDesktop` wrapper alone leaves this file unguarded, so these tests
 * drive the rendered page.
 *
 * NOTE ON COVERAGE: the sibling "Install BcContainerHelper" action is NOT
 * covered here because it is currently unreachable. `checkAllStatus` never
 * assigns `bcContainerHelper: 'not_installed'` (grep: the literal appears only
 * in the type union, the status-formatting switches and the render guards), and
 * the Install Module button is gated on exactly that value. See the repair
 * report — this is a live gap, not a testing shortcut.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SetupPage from '@/app/setup/page';

jest.mock('@/lib/electron-api', () => ({
  isElectron: jest.fn(() => true),
  openExternal: jest.fn(),
  startDockerDesktop: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    loading: jest.fn(),
    dismiss: jest.fn(),
  },
}));

import { toast } from 'react-hot-toast';
import { startDockerDesktop } from '@/lib/electron-api';

const mockStartDockerDesktop = startDockerDesktop as jest.MockedFunction<typeof startDockerDesktop>;
const mockToastSuccess = toast.success as jest.MockedFunction<typeof toast.success>;
const mockToastError = toast.error as jest.MockedFunction<typeof toast.error>;

// The pre-fix page reached window.electronAPI.powershell.run directly. It is
// stubbed so a reverted page.tsx runs to completion and fails on the assertions
// rather than on an undefined property.
const powershellRun = jest.fn();
const getDockerInfo = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  powershellRun.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
  // success:false puts the Docker tiles in installed/stopped, which is what
  // renders the "Start Docker" button.
  getDockerInfo.mockResolvedValue({ success: false });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    isElectron: true,
    powershell: { run: powershellRun, runWithPassword: jest.fn(), onOutput: jest.fn(() => jest.fn()) },
    docker: { getDockerInfo, startDesktop: jest.fn() },
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function clickStartDocker(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole('button', { name: /Start Docker/i });
  await user.click(button);
}

describe('Setup page — Start Docker Desktop', () => {
  it('uses the dedicated main-process launcher, not a generic command runner', async () => {
    mockStartDockerDesktop.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<SetupPage />);

    await clickStartDocker(user);

    await waitFor(() => expect(mockStartDockerDesktop).toHaveBeenCalledTimes(1));
    expect(powershellRun).not.toHaveBeenCalled();
  });

  it('surfaces a launch failure instead of reporting success', async () => {
    mockStartDockerDesktop.mockResolvedValue({
      success: false,
      error: 'Docker Desktop executable not found',
    });
    const user = userEvent.setup();
    render(<SetupPage />);

    await clickStartDocker(user);

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError.mock.calls[0][0]).toContain('Docker Desktop executable not found');
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('reports success only when the launcher reports success', async () => {
    mockStartDockerDesktop.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<SetupPage />);

    await clickStartDocker(user);

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(mockToastSuccess.mock.calls[0][0]).toMatch(/Docker Desktop starting/i);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});

describe('Setup page — BcContainerHelper install action', () => {
  // Characterisation, not a guard: this pins the reachability gap described in
  // the file header. When it fails, someone has added a real probe that can
  // yield 'not_installed' — at that point add the toast assertions for the
  // failure path of handleInstallBcHelper.
  it('never renders the Install Module button because no probe yields not_installed', async () => {
    getDockerInfo.mockResolvedValue({ success: true, data: { version: '27.0', containers: 3 } });
    render(<SetupPage />);

    await waitFor(() => expect(screen.getByText('BcContainerHelper')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Install Module/i })).not.toBeInTheDocument();
  });
});
