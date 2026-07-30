/**
 * Call-site tests for the Create Container wizard.
 *
 * The NavUserPassword bug lived here, not in `lib/electron-api`: the wizard
 * persisted the password via `setSetting('deployPassword', ...)` (a key outside
 * ALLOWED_SETTINGS_KEYS, so the write was discarded) and passed
 * `-PasswordFile 'env:BC_DEPLOY_PASSWORD'` to a script that declared no such
 * parameter and had no such env var. Tests that only exercise the two-line
 * `lib/electron-api` wrappers stay green when this file is reverted, so these
 * drive the rendered wizard and assert on the channel and the exact argv.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateContainerPage from '@/app/create/page';
import { DeploymentProvider } from '@/lib/deployment-context';

jest.mock('@/lib/electron-api', () => ({
  isElectron: jest.fn(() => true),
  runPowerShell: jest.fn(),
  runPowerShellWithPassword: jest.fn(),
  // The pre-fix wizard called setSetting('deployPassword', ...). It is mocked
  // so a reverted page.tsx still runs to completion and fails on the
  // assertions below rather than on an undefined import.
  setSetting: jest.fn(),
  // DeploymentProvider subscribes on mount and calls the returned unsubscribe.
  onPowerShellOutput: jest.fn(() => jest.fn()),
}));

jest.mock('react-hot-toast', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    loading: jest.fn(),
    dismiss: jest.fn(),
  },
}));

import {
  runPowerShell,
  runPowerShellWithPassword,
  setSetting,
} from '@/lib/electron-api';

const mockRunPowerShell = runPowerShell as jest.MockedFunction<typeof runPowerShell>;
const mockRunWithPassword = runPowerShellWithPassword as jest.MockedFunction<
  typeof runPowerShellWithPassword
>;
const mockSetSetting = setSetting as jest.MockedFunction<typeof setSetting>;

const PASSWORD = 'P@ssw0rd-not-a-real-secret';
const OK = { stdout: '', stderr: '', exitCode: 0 };

function renderWizard() {
  return render(
    <DeploymentProvider>
      <CreateContainerPage />
    </DeploymentProvider>
  );
}

async function deployWithNavUserPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('mybc-latest'), 'bcserver-test');
  const password = document.querySelector('input[type="password"]') as HTMLInputElement;
  await user.type(password, PASSWORD);
  await user.click(screen.getByRole('button', { name: /Deploy Container/i }));
}

describe('Create Container wizard — NavUserPassword deployment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunWithPassword.mockResolvedValue(OK);
    mockRunPowerShell.mockResolvedValue(OK);
  });

  it('sends the password over the dedicated password channel', async () => {
    const user = userEvent.setup();
    renderWizard();
    await deployWithNavUserPassword(user);

    await waitFor(() => expect(mockRunWithPassword).toHaveBeenCalledTimes(1));
    expect(mockRunPowerShell).not.toHaveBeenCalled();

    const [script, , password] = mockRunWithPassword.mock.calls[0];
    expect(script).toBe('scripts/Deploy-BC-Container.ps1');
    expect(password).toBe(PASSWORD);
  });

  it('never writes the password into the settings store', async () => {
    const user = userEvent.setup();
    renderWizard();
    await deployWithNavUserPassword(user);

    await waitFor(() => expect(mockRunWithPassword).toHaveBeenCalledTimes(1));
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('builds argv from declared parameters only, with no password and no env: sentinel', async () => {
    const user = userEvent.setup();
    renderWizard();
    await deployWithNavUserPassword(user);

    await waitFor(() => expect(mockRunWithPassword).toHaveBeenCalledTimes(1));
    const args = mockRunWithPassword.mock.calls[0][1];

    expect(args).toEqual(
      expect.arrayContaining([
        '-Version',
        '-ContainerName',
        'bcserver-test',
        '-Auth',
        'NavUserPassword',
        '-Isolation',
        '-Username',
        'admin',
      ])
    );

    // -PasswordFile is appended by the main process after argument validation;
    // the renderer must not supply it (and certainly not the env: sentinel the
    // script never read).
    expect(args).not.toContain('-PasswordFile');
    expect(args.some((a) => /^\$?env:/i.test(a))).toBe(false);
    expect(args).not.toContain(PASSWORD);
  });

  it('keeps the password out of the deployment output console', async () => {
    const user = userEvent.setup();
    const { container } = renderWizard();
    await deployWithNavUserPassword(user);

    await waitFor(() => expect(mockRunWithPassword).toHaveBeenCalledTimes(1));
    expect(container.textContent).not.toContain(PASSWORD);
  });

  it('reports a non-zero exit code as a failure instead of success', async () => {
    mockRunWithPassword.mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });
    const user = userEvent.setup();
    renderWizard();
    await deployWithNavUserPassword(user);

    await waitFor(() =>
      expect(screen.getByText(/Deployment failed with exit code 1/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/Container deployed successfully/)).not.toBeInTheDocument();
  });
});

describe('Create Container wizard — Windows authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunWithPassword.mockResolvedValue(OK);
    mockRunPowerShell.mockResolvedValue(OK);
  });

  it('uses the plain PowerShell channel and passes no credentials', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByPlaceholderText('mybc-latest'), 'bcserver-win');
    await user.click(screen.getByRole('radio', { name: /Windows Auth/i }));
    await user.click(screen.getByRole('button', { name: /Deploy Container/i }));

    await waitFor(() => expect(mockRunPowerShell).toHaveBeenCalledTimes(1));
    expect(mockRunWithPassword).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();

    const args = mockRunPowerShell.mock.calls[0][1] as string[];
    expect(args).toContain('-Auth');
    expect(args).toContain('Windows');
    expect(args).not.toContain('-Username');
    expect(args).not.toContain('-PasswordFile');
  });
});
