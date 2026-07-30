/**
 * Call-site tests for the Settings page's handling of the write-only API key.
 *
 * The pre-fix page called getSetting('anthropicApiKey') and loaded the
 * decrypted key into the input, then wrote the field back on every save.
 * Tests that only exercise the lib/electron-api wrappers stay green when this
 * file is reverted, so these drive the rendered page: the key must never be
 * fetched, never appear in the DOM, and never be overwritten by a blank save.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsPage from '@/app/settings/page';

jest.mock('@/lib/electron-api', () => ({
  isElectron: jest.fn(() => true),
  getAllSettings: jest.fn(),
  // The pre-fix page imported getSetting. It is mocked to hand the secret
  // back, so a reverted page.tsx runs to completion and fails on the
  // assertions below rather than on an undefined import.
  getSetting: jest.fn(),
  setSetting: jest.fn(),
  getAppInfo: jest.fn(),
  listContainers: jest.fn(),
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
import {
  getAllSettings,
  getSetting,
  setSetting,
  getAppInfo,
} from '@/lib/electron-api';

const mockGetAllSettings = getAllSettings as jest.MockedFunction<typeof getAllSettings>;
const mockGetSetting = getSetting as jest.MockedFunction<typeof getSetting>;
const mockSetSetting = setSetting as jest.MockedFunction<typeof setSetting>;
const mockGetAppInfo = getAppInfo as jest.MockedFunction<typeof getAppInfo>;
const mockToastSuccess = toast.success as jest.MockedFunction<typeof toast.success>;
const mockToastError = toast.error as jest.MockedFunction<typeof toast.error>;

const STORED_SECRET = 'sk-ant-stored-write-only-secret';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllSettings.mockResolvedValue({
    backupRoot: 'C:\\BCBackups',
    autoRefreshInterval: 30,
    anthropicApiKeySet: true,
  });
  mockGetSetting.mockImplementation(async (key: string) => {
    if (key === 'anthropicApiKey') return STORED_SECRET as never;
    if (key === 'backupRoot') return 'C:\\BCBackups' as never;
    if (key === 'autoRefreshInterval') return 30 as never;
    return undefined as never;
  });
  mockSetSetting.mockResolvedValue(undefined);
  mockGetAppInfo.mockResolvedValue(null);
});

async function renderLoadedPage() {
  const view = render(<SettingsPage />);
  await screen.findByRole('button', { name: /Save Settings/i });
  return view;
}

describe('Settings page — write-only API key', () => {
  it('never fetches the stored key and never puts it in the DOM', async () => {
    const { container } = await renderLoadedPage();

    expect(mockGetSetting).not.toHaveBeenCalledWith('anthropicApiKey');
    expect(container.innerHTML).not.toContain(STORED_SECRET);
    expect(screen.getByText('A key is stored and encrypted')).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/Enter a new key to replace the stored one/i);
    expect(input).toHaveValue('');
  });

  it('leaves the stored key alone when saving with the field blank', async () => {
    const user = userEvent.setup();
    await renderLoadedPage();

    await user.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    const keysWritten = mockSetSetting.mock.calls.map(([key]) => key);
    expect(keysWritten).not.toContain('anthropicApiKey');
    expect(keysWritten).toContain('backupRoot');
    expect(keysWritten).toContain('autoRefreshInterval');
  });

  it('saves a newly entered key and clears the field afterwards', async () => {
    const user = userEvent.setup();
    await renderLoadedPage();

    const input = screen.getByPlaceholderText(/Enter a new key to replace the stored one/i);
    await user.type(input, 'sk-ant-replacement');
    await user.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() =>
      expect(mockSetSetting).toHaveBeenCalledWith('anthropicApiKey', 'sk-ant-replacement')
    );
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('removes the stored key through an explicit empty write', async () => {
    const user = userEvent.setup();
    await renderLoadedPage();

    await user.click(screen.getByRole('button', { name: /Remove stored key/i }));

    await waitFor(() => expect(mockSetSetting).toHaveBeenCalledWith('anthropicApiKey', ''));
    expect(await screen.findByText('No key stored')).toBeInTheDocument();
  });

  it('surfaces a rejected save instead of toasting success', async () => {
    mockSetSetting.mockRejectedValue(new Error('Invalid value for setting "backupRoot"'));
    const user = userEvent.setup();
    await renderLoadedPage();

    await user.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError.mock.calls[0][0]).toContain('Invalid value for setting "backupRoot"');
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
