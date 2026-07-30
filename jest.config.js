const nextJest = require('next/jest');

const createJestConfig = nextJest({
  // Path to Next.js app for loading next.config.js and .env files
  dir: './',
});

/** @type {import('jest').Config} */
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'jest-environment-jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)',
  ],
  collectCoverageFrom: [
    'components/**/*.{js,jsx,ts,tsx}',
    'lib/**/*.{js,jsx,ts,tsx}',
    'app/**/*.{js,jsx,ts,tsx}',
    'electron/**/*.js',
    '!**/*.d.ts',
    '!**/node_modules/**',
  ],
  // Coverage report without enforced thresholds
  // Current coverage for tested components:
  // - ContainerCard.tsx: 100% statements, 87% branches
  // - LogViewer.tsx: 97% statements, 100% branches
  // - ai-client.ts: 100% statements, 93% branches
};

module.exports = createJestConfig(customJestConfig);
