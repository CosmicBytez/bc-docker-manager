# CLAUDE.md

## BC Docker Manager

Desktop application (Electron 41 + Next.js 16) for managing Business Central Docker containers. Native Windows app for container management, log viewing, backup operations, AI-powered troubleshooting, and one-click container deployment. Standalone repo: `CosmicBytez/bc-docker-manager`.

## Stack

- **Desktop shell**: Electron 41 (main + preload + IPC handlers)
- **Frontend**: Next.js 16 (App Router, static export), React 19, TypeScript
- **Styling**: Tailwind CSS with custom theme
- **AI**: `@anthropic-ai/sdk` called directly from the Electron main process via IPC (renderer never sees the key)
- **PowerShell**: Bundled scripts executed from the main process; streaming stdout via IPC
- **Docker**: Docker Engine API via named pipe (`//./pipe/docker_engine`) in web mode

## Architecture

### Desktop App (Electron)
- **Main Process** - `electron/main.js` - Window management, IPC, PowerShell execution
- **Preload Script** - `electron/preload.js` - Secure bridge between main and renderer
- **IPC Handlers** - `electron/ipc-handlers.js` - Docker/backup/AI operations

### Frontend (React/Next.js)
- **App Router** - Uses Next.js 16 app directory structure
- **Client Components** - Interactive pages marked with 'use client'
- **Tailwind CSS** - Utility-first styling with custom theme
- **API Abstraction** - `lib/electron-api.ts` - Works in both web and Electron

### Key Files

| File | Purpose |
|------|---------|
| `electron/main.js` | Electron main process entry point |
| `electron/preload.js` | Secure IPC bridge |
| `electron/ipc-handlers.js` | All backend operations (Docker, backups, AI) |
| `lib/electron-api.ts` | Unified API for web/Electron |
| `lib/env.ts` | Web/Electron env detection — Docker ops run via `dockerode` in `electron/ipc-handlers.js` (there is no `lib/docker-api.ts`) |
| `lib/types.ts` | TypeScript interfaces |
| `app/create/page.tsx` | Container creation wizard |
| `app/settings/page.tsx` | App configuration |
| `lib/hns-error-detector.ts` | HNS error pattern detection |
| `lib/deployment-context.tsx` | React Context provider for deployment state (status, output, container name) shared across the creation wizard |
| `electron/rag-helper.js` | RAG over BC/Docker HOWTO `.md` docs (AI context + offline fallback); honors `BC_HOWTO_PATH`, else probes AZU-VAULT `HOWTO's/CONTAINERS` |
| `middleware.ts` | CSRF protection |

## Development Commands

```bash
# Web development (Next.js only)
npm run dev           # Start Next.js dev server on port 3000 (web/browser mode only, no Electron)

# Electron development
npm run electron:dev  # Start Next.js on port 3333 + launch Electron together

# Building
npm run build         # Web-mode build (dynamic API routes) — NOT the static export
npm run build:electron # Static export for Electron (ELECTRON_BUILD=1 gates output:'export' in next.config.js)
npm run electron:build:win     # Build Windows installer
npm run electron:build:portable # Build portable .exe
npm run electron:pack  # Build unpacked dir (used by CI, no installer)

# Testing
npm run test          # Run Jest tests
npm run lint          # Run ESLint
```

## Testing

```bash
npm test              # Run Jest test suite
npm run test:coverage # With coverage report
```

Test files in `__tests__/` directory using React Testing Library.

## Container Naming Convention

The app filters for Docker containers whose name contains `bc` (case-insensitive).
Matches `bcserver-bc25`, `mybc-test`, `bc-preview`, etc. Defined in
`electron/ipc-handlers.js`:

```js
const BC_CONTAINER_PATTERN = /bc/i;
```

The permissiveness is intentional — users name BC containers many different
ways. A stricter `^bcserver` would miss common real-world conventions.

## API Design

### Electron Mode (Desktop App)
Uses IPC via `window.electronAPI`:
```typescript
import { listContainers } from '@/lib/electron-api';
const containers = await listContainers();
```

### Web Mode (Fallback)
Uses Next.js API routes via fetch:
```typescript
const response = await fetch('/api/containers');
```

### Response Pattern
```typescript
{ success: true, data: [...] }
{ success: false, error: "Error message" }
```

## PowerShell Integration

The desktop app can execute PowerShell scripts:

```typescript
import { runPowerShell, onPowerShellOutput } from '@/lib/electron-api';

// Subscribe to real-time output
const unsubscribe = onPowerShellOutput((data) => {
  console.log(data.type, data.data);
});

// Execute script
const result = await runPowerShell('scripts/Install-BC-Helper.ps1', [
  '-Version', 'Latest',
  '-ContainerName', 'bcserver-test'
]);
```

## Settings Storage

Desktop app settings are stored in:
- Windows: `%APPDATA%/bc-container-manager/settings.json`

Available settings:
- `anthropicApiKey` - Claude API key for troubleshooting
- `backupRoot` - Backup directory path
- `autoRefreshInterval` - Dashboard refresh rate

## Building for Distribution

1. **Add app icons** to `assets/`:
   - `icon.ico` (Windows)
   - `icon.png` (512x512)
   - `icon.icns` (macOS, optional)

2. **Build the app**:
   ```bash
   npm run electron:build:win
   ```

3. **Output**:
   - Installer: `dist7/BC Container Manager-Setup-${version}.exe`
   - Portable: `dist7/BC Container Manager-Portable-${version}.exe`

## Project Structure

```
BC-Docker-Manager/
├── electron/
│   ├── main.js           # Main process
│   ├── preload.js        # Preload script
│   └── ipc-handlers.js   # IPC handlers
├── app/
│   ├── create/           # Container creation wizard
│   ├── setup/            # First-run setup flow
│   ├── settings/         # App settings
│   ├── dashboard/        # Container list
│   ├── container/        # Per-container detail view
│   ├── backups/          # Backup management
│   └── troubleshoot/     # AI chat
├── lib/
│   ├── electron-api.ts   # Unified API layer
│   ├── env.ts            # Web/Electron env detection (Docker ops via dockerode in electron/)
│   └── types.ts          # TypeScript types
├── scripts/
│   ├── Install-BC-Helper.ps1   # Primary deployment script (uses BcContainerHelper)
│   ├── Deploy-BC-Container.ps1 # Alternative deployment (direct Docker, bypasses HNS issues)
│   ├── Fix-HNS-State.ps1       # HNS cleanup script
│   ├── Diagnose-HNS-Ports.ps1  # Network diagnostics
│   ├── Backup-BC-Container.ps1 # Backup operations
│   └── Restore-BC-Container.ps1 # Restore operations
├── assets/               # App icons
├── electron-builder.yml  # Build configuration
└── package.json
```

## Deployment Scripts

The app bundles two deployment approaches:

### Deploy-BC-Container.ps1 (Primary - Used by App)
- Uses direct Docker commands (bypasses BcContainerHelper entirely)
- **Works reliably on Windows 11 24H2** where BcContainerHelper fails with HNS errors
- Simpler password handling via `passwordFile` environment variable
- 20-minute health check timeout for first-time deployments
- **Used by the app's Create Container wizard**

### Install-BC-Helper.ps1 (Standalone/Manual Use)
- Uses BcContainerHelper PowerShell module with `New-BcContainer` cmdlet
- Built-in HNS cleanup and retry logic
- **Fails on Windows 11 24H2** with persistent HNS 0x803b0013 port conflict errors
- Kept for standalone use when BcContainerHelper works (older Windows versions)
- Not used by the app due to HNS issues

## Related Projects

- **PowerShell Scripts** - `Script DB/Windows_Scripts/Docker Dev/`
  - `Install-BC-Helper.ps1` - Main deployment script (bundled in app)
  - `Backup-BC-Container.ps1` - Backup operations
  - `Get-BC-ContainerStatus.ps1` - Diagnostics
  - `DockerHelpers.psm1` - PowerShell module for Docker operations

## HNS Error Detection & Recovery

The app detects and recovers from HNS (Host Network Service) issues — port conflicts (`0x803b0013`), endpoint errors, NAT mapping conflicts, and service failures. Key components: `lib/hns-error-detector.ts` (detection), `HNSErrorRecovery.tsx` (recovery UI), `NetworkDiagnostics.tsx` (proactive scanning), `scripts/Fix-HNS-State.ps1` (cleanup), `scripts/Diagnose-HNS-Ports.ps1` (diagnostics).

See [docs/hns-troubleshooting.md](docs/hns-troubleshooting.md) for full details.

## Troubleshooting

- **HNS port conflicts**: App auto-detects and shows recovery panel → Run Diagnostics → Clean HNS State → Retry. Manual: `.\scripts\Fix-HNS-State.ps1 -Force`
- **Docker connection**: Ensure Docker Desktop is running; app connects to `//./pipe/docker_engine`
- **Electron build fails**: Run `npm install` then `npm run build` before Electron build; check `assets/` has icon files
- **PowerShell scripts not running**: Must be in `scripts/` dir, execution policy must allow, **run as administrator** (required for HNS cmdlets)
- **Settings not saving**: Check write permissions to `%APPDATA%/bc-container-manager/settings.json`

## Environment Variables

This is a desktop app, so most config lives in `%APPDATA%/bc-container-manager/settings.json` rather than `.env` files. Relevant env vars for development:

| Variable | Scope | Purpose |
|----------|-------|---------|
| `ANTHROPIC_API_KEY` | Dev only | Falls back when `anthropicApiKey` is not set in app settings (useful for `npm run electron:dev`) |
| `NODE_ENV` | Build | Electron's `main.js` checks for `development` to enable DevTools |

App settings (stored in `settings.json`, not env):
- `anthropicApiKey` — Claude API key for troubleshooting
- `backupRoot` — Backup directory path
- `autoRefreshInterval` — Dashboard refresh rate (seconds)

## CI/CD

GitHub Actions (7 workflows in `.github/workflows/`):
- `build-test.yml` — Windows runner, Node 22, type-check, tests, electron:pack
- `ci.yml` — Lint and build checks
- `release.yml` — Release automation
- `auto-fix.yml`, `claude.yml`, `claude-code-review.yml`, `scheduled-checks.yml` — Claude automation + scheduled checks

## Before Committing

1. `npm run lint` — fix ESLint errors
2. `npm test` — Jest suite must pass
3. `npm run build` — Next.js web-mode build (dynamic API routes) must succeed
4. `npm run build:electron` — Next.js **static export** (`output: 'export'`) must succeed. This is what `release.yml` runs and it enforces the `dynamic = 'force-static'` + GET-only constraint for API routes. Running only `npm run build` is NOT sufficient — it will pass locally while the release build fails on CI.
5. No `anthropicApiKey`, passwords, or API tokens in source or test fixtures
6. PowerShell scripts in `scripts/` stay self-contained — no hard-coded paths outside `%APPDATA%`

## Cluster
Apps

## Dependencies
- Upstream: None (Electron desktop app, self-contained)
- Downstream: None

## Agents & Skills
- Cluster agents: app-qa
- Cluster skills: /app-deploy
- Universal: /dashboard, /triage, /kickoff, /release-prep, /impact-check

