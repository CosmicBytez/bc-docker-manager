/**
 * Unit tests for the Electron main-process helpers.
 *
 * @jest-environment node
 */

// The module is loaded in the main process, so `electron` and the RAG helper
// have to be stubbed before require().
jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v) => Buffer.from(v),
    decryptString: (b) => b.toString(),
  },
}));

jest.mock('../../electron/rag-helper', () => ({
  buildContext: jest.fn(),
  getOfflineResponse: jest.fn(),
  listDocuments: jest.fn(),
}));

const {
  APIConnectionError,
  APIConnectionTimeoutError,
  BadRequestError,
  RateLimitError,
} = require('@anthropic-ai/sdk');

const {
  ALLOWED_SETTINGS_KEYS,
  READABLE_SETTINGS_KEYS,
  WRITE_ONLY_SETTINGS_KEYS,
  SETTINGS_VALIDATORS,
  validateContainerId,
  validateFilePath,
  buildApiMessages,
  isConnectivityError,
} = require('../../electron/ipc-handlers');

describe('validateContainerId', () => {
  it.each([
    'bcserver-bc25',
    'a1b2c3d4e5f6',
    'my_bc.container-1',
    'B',
  ])('accepts %s', (id) => {
    expect(validateContainerId(id).valid).toBe(true);
  });

  it.each([
    ['', 'empty string'],
    ['-leading-dash', 'leading dash'],
    ['has space', 'space'],
    ['semi;colon', 'shell metacharacter'],
    ['../etc/passwd', 'path traversal'],
    ['name$(whoami)', 'command substitution'],
  ])('rejects %s (%s)', (id) => {
    expect(validateContainerId(id).valid).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(validateContainerId(null).valid).toBe(false);
    expect(validateContainerId(42).valid).toBe(false);
    expect(validateContainerId(undefined).valid).toBe(false);
  });

  it('rejects ids longer than 128 characters', () => {
    expect(validateContainerId('a'.repeat(129)).valid).toBe(false);
    expect(validateContainerId('a'.repeat(128)).valid).toBe(true);
  });
});

describe('validateFilePath', () => {
  const root = '/backups';

  it('accepts a path inside the allowed root', () => {
    const result = validateFilePath('/backups/bcserver/db.bak', root);
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBe('/backups/bcserver/db.bak');
  });

  it('accepts the root itself', () => {
    expect(validateFilePath('/backups', root).valid).toBe(true);
  });

  it('rejects traversal out of the root', () => {
    expect(validateFilePath('/backups/../etc/passwd', root).valid).toBe(false);
    expect(validateFilePath('/etc/passwd', root).valid).toBe(false);
  });

  it('rejects a sibling directory with the root as a name prefix', () => {
    expect(validateFilePath('/backups-evil/db.bak', root).valid).toBe(false);
  });

  it('rejects empty or non-string paths', () => {
    expect(validateFilePath('', root).valid).toBe(false);
    expect(validateFilePath(null, root).valid).toBe(false);
  });
});

describe('SETTINGS_VALIDATORS', () => {
  it('has a validator for every allowed key', () => {
    for (const key of ALLOWED_SETTINGS_KEYS) {
      expect(typeof SETTINGS_VALIDATORS[key]).toBe('function');
    }
  });

  describe('autoRefreshInterval', () => {
    const validate = (v) => SETTINGS_VALIDATORS.autoRefreshInterval(v);

    // Regression: the validator required milliseconds (1000..300000) while
    // every caller uses seconds, so settings:set always returned success:false.
    it.each([10, 30, 60, 120, 300])('accepts the settings page option %i (seconds)', (seconds) => {
      expect(validate(seconds)).toBe(true);
    });

    it('rejects values outside the seconds range', () => {
      expect(validate(0)).toBe(false);
      expect(validate(4)).toBe(false);
      expect(validate(3601)).toBe(false);
    });

    it('rejects non-finite and non-numeric values', () => {
      expect(validate(NaN)).toBe(false);
      expect(validate(Infinity)).toBe(false);
      expect(validate('30')).toBe(false);
      expect(validate(null)).toBe(false);
    });
  });

  it('bounds string settings', () => {
    expect(SETTINGS_VALIDATORS.anthropicApiKey('sk-ant-test')).toBe(true);
    expect(SETTINGS_VALIDATORS.anthropicApiKey('x'.repeat(501))).toBe(false);
    expect(SETTINGS_VALIDATORS.backupRoot('x'.repeat(261))).toBe(false);
    expect(SETTINGS_VALIDATORS.theme('dark')).toBe(true);
    expect(SETTINGS_VALIDATORS.theme('neon')).toBe(false);
  });
});

describe('settings key allowlists', () => {
  it('keeps the API key writable', () => {
    expect(ALLOWED_SETTINGS_KEYS).toContain('anthropicApiKey');
  });

  it('never exposes the API key to the renderer', () => {
    expect(WRITE_ONLY_SETTINGS_KEYS).toContain('anthropicApiKey');
    expect(READABLE_SETTINGS_KEYS).not.toContain('anthropicApiKey');
  });

  it('keeps every other allowed key readable', () => {
    for (const key of ALLOWED_SETTINGS_KEYS) {
      if (WRITE_ONLY_SETTINGS_KEYS.includes(key)) continue;
      expect(READABLE_SETTINGS_KEYS).toContain(key);
    }
  });
});

describe('buildApiMessages', () => {
  const user = (content) => ({ role: 'user', content });
  const assistant = (content) => ({ role: 'assistant', content });

  // Regression: the chat transcript always opens with a welcome message, so
  // sending it verbatim made the Messages API reject every request with a 400.
  it('drops the leading assistant turn', () => {
    const result = buildApiMessages([assistant('welcome'), user('hi')]);
    expect(result).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops several leading assistant turns', () => {
    const result = buildApiMessages([assistant('a'), assistant('b'), user('hi')]);
    expect(result[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('starts the window on a user turn when the transcript is longer than the window', () => {
    // 12 alternating messages starting with the assistant welcome: a naive
    // slice(-10) would start on an assistant turn.
    const messages = [assistant('welcome')];
    for (let i = 0; i < 6; i++) {
      messages.push(user(`q${i}`));
      messages.push(assistant(`a${i}`));
    }

    const result = buildApiMessages(messages, 10);

    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result[0].role).toBe('user');
    expect(result[result.length - 1]).toEqual({ role: 'assistant', content: 'a5' });
  });

  it('always returns a user-first array for any transcript shape', () => {
    const shapes = [
      [assistant('w'), user('a')],
      [assistant('w'), user('a'), assistant('b')],
      [user('a')],
      [assistant('w'), assistant('x'), user('a'), assistant('b'), user('c')],
    ];

    for (const shape of shapes) {
      const result = buildApiMessages(shape, 4);
      expect(result[0].role).toBe('user');
    }
  });

  it('returns an empty array when there is no user turn', () => {
    expect(buildApiMessages([assistant('welcome')])).toEqual([]);
    expect(buildApiMessages([])).toEqual([]);
  });

  it('keeps only role and content', () => {
    const result = buildApiMessages([user('hi')]);
    expect(Object.keys(result[0]).sort()).toEqual(['content', 'role']);
  });
});

describe('isConnectivityError', () => {
  // Cases are built from the installed SDK's own error classes. Hand-built
  // `{ name: 'APIConnectionError' }` / `{ code: 'ENOTFOUND' }` objects are
  // shapes the SDK never produces: no SDK error class assigns `this.name`
  // (every one reports `name === 'Error'`), and the socket code lives on
  // `error.cause`, not on the error itself.
  const socketCause = (code) =>
    Object.assign(new Error(`getaddrinfo ${code} api.anthropic.com`), { code });

  it('is exercised against the real SDK error shapes, not hand-built stand-ins', () => {
    const real = new APIConnectionError({ message: 'Connection error.', cause: socketCause('ENOTFOUND') });
    // Pins the two properties that made the previous implementation dead code.
    expect(real.name).toBe('Error');
    expect(real.code).toBeUndefined();
    expect(real.cause.code).toBe('ENOTFOUND');
    expect(real.constructor.name).toBe('APIConnectionError');
  });

  it('treats an HTTP status as an API-level rejection', () => {
    const badRequest = new BadRequestError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
      'bad',
      new Headers()
    );
    const rateLimited = new RateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      'slow down',
      new Headers()
    );
    expect(isConnectivityError(badRequest)).toBe(false);
    expect(isConnectivityError(rateLimited)).toBe(false);
    expect(isConnectivityError({ status: 401 })).toBe(false);
  });

  it('recognises a real APIConnectionError', () => {
    expect(
      isConnectivityError(new APIConnectionError({ message: 'Connection error.', cause: socketCause('ENOTFOUND') }))
    ).toBe(true);
  });

  it('recognises a real APIConnectionTimeoutError', () => {
    expect(isConnectivityError(new APIConnectionTimeoutError({ message: 'Request timed out.' }))).toBe(true);
  });

  it('recognises a bare socket failure and one wrapped in a cause chain', () => {
    // Not every transport failure arrives via the SDK — dockerode/undici raise
    // the Node error directly.
    expect(isConnectivityError(socketCause('ECONNREFUSED'))).toBe(true);
    expect(isConnectivityError(new Error('wrapped', { cause: socketCause('EAI_AGAIN') }))).toBe(true);
  });

  it('does not treat arbitrary errors as connectivity failures', () => {
    expect(isConnectivityError(new Error('boom'))).toBe(false);
    expect(isConnectivityError(new Error('nested', { cause: new Error('inner') }))).toBe(false);
    expect(isConnectivityError(null)).toBe(false);
    expect(isConnectivityError('ENOTFOUND')).toBe(false);
  });
});
