/**
 * Call-site test for the `ai:chat` IPC handler's offline degradation path.
 *
 * `isConnectivityError()` gates the branch that returns RAG-backed offline
 * documentation when the machine cannot reach the Claude API. Testing the
 * predicate alone is not enough: the regression that mattered was user-visible
 * (an offline user WITH a valid key got a red "Claude API error" banner instead
 * of the offline docs), and it only shows up when the real SDK error travels
 * through the handler.
 *
 * Every error here is a genuine `@anthropic-ai/sdk` instance — hand-built
 * `{ name: 'APIConnectionError' }` / `{ code: 'ENOTFOUND' }` literals are
 * shapes the SDK never produces and pass against a broken predicate.
 *
 * @jest-environment node
 */

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v) => Buffer.from(v),
    decryptString: (b) => b.toString(),
  },
}));

jest.mock('../../electron/rag-helper', () => ({
  buildContext: jest.fn().mockResolvedValue(''),
  getOfflineResponse: jest.fn().mockResolvedValue({
    content: 'Offline answer about HNS port conflicts.',
    sources: ['hns-troubleshooting.md'],
  }),
  listDocuments: jest.fn().mockResolvedValue([]),
}));

// Replace only the client constructor. `jest.requireActual` keeps the real
// error classes, so the `APIConnectionError` the module under test sees is the
// same class the assertions below construct — a bare factory would hand the
// two sides different classes and make `instanceof` silently fail.
const messagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk');
  class MockAnthropic {
    constructor() {
      this.messages = { create: (...args) => messagesCreate(...args) };
    }
  }
  return { ...actual, __esModule: true, default: MockAnthropic };
});

const { APIConnectionError, APIConnectionTimeoutError, BadRequestError } = require('@anthropic-ai/sdk');
const { registerIpcHandlers } = require('../../electron/ipc-handlers');

function registerAndGetHandlers() {
  const handlers = new Map();
  registerIpcHandlers({ handle: (channel, fn) => handlers.set(channel, fn) });
  return handlers;
}

const MESSAGES = [{ role: 'user', content: 'Why does my container fail to start?' }];

describe('ai:chat offline degradation', () => {
  let chat;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(() => {
    const handlers = registerAndGetHandlers();
    chat = handlers.get('ai:chat');
  });

  beforeEach(() => {
    // A valid key is the whole point: the offline branch must fire for a user
    // who is configured correctly but has no network.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    messagesCreate.mockReset();
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('registers the handler', () => {
    expect(typeof chat).toBe('function');
  });

  it('falls back to offline documentation on a real APIConnectionError', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
      code: 'ENOTFOUND',
    });
    messagesCreate.mockRejectedValue(new APIConnectionError({ message: 'Connection error.', cause }));

    const result = await chat({}, MESSAGES);

    expect(result.success).toBe(true);
    expect(result.data.isOffline).toBe(true);
    expect(result.data.sources).toEqual(['hns-troubleshooting.md']);
    expect(result.data.content).toContain('Offline answer about HNS port conflicts.');
  });

  it('falls back to offline documentation on a real APIConnectionTimeoutError', async () => {
    messagesCreate.mockRejectedValue(new APIConnectionTimeoutError({ message: 'Request timed out.' }));

    const result = await chat({}, MESSAGES);

    expect(result.success).toBe(true);
    expect(result.data.isOffline).toBe(true);
    expect(result.data.sources).toEqual(['hns-troubleshooting.md']);
  });

  it('surfaces an API-level rejection instead of masking it as offline mode', async () => {
    messagesCreate.mockRejectedValue(
      new BadRequestError(
        400,
        { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
        'bad',
        new Headers()
      )
    );

    const result = await chat({}, MESSAGES);

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 400');
  });

  it('surfaces an unrelated error instead of masking it as offline mode', async () => {
    messagesCreate.mockRejectedValue(new Error('something else broke'));

    const result = await chat({}, MESSAGES);

    expect(result.success).toBe(false);
    expect(result.error).toContain('something else broke');
  });
});
