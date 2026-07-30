/**
 * Contract test: every PowerShell argument used in the app must exist as a
 * parameter of the script it is passed to.
 *
 * Both the Create Container wizard (-PasswordFile) and the Setup page
 * (-InstallModuleOnly) shipped flags that no script declared. Because
 * PowerShell scripts use [CmdletBinding()], an unknown parameter is a
 * ParameterBindingException: the script body never runs and the UI reports a
 * generic failure. This test pins the argument names to the param blocks.
 *
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

// Directories whose source is scanned for script invocations.
const SCANNED_DIRS = ['app', 'components', 'electron', 'lib'];
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

// powershell.exe's own flags — they are consumed by the host, not the script.
const POWERSHELL_HOST_FLAGS = new Set([
  '-NoProfile',
  '-ExecutionPolicy',
  '-File',
  '-Command',
  '-NoLogo',
  '-NonInteractive',
  '-WindowStyle',
  '-InputFormat',
  '-OutputFormat',
]);

/**
 * Extracts the parameter names declared in a script's top-level param() block.
 * @returns {Set<string>} parameter names without the leading '$'
 */
function parseParamBlock(scriptSource) {
  const params = new Set();
  const match = /^param\s*\(/m.exec(scriptSource);
  if (!match) return params;

  // Walk from the opening paren to its match so nested [ValidateSet(...)] and
  // default values do not terminate the block early.
  let depth = 0;
  let end = -1;
  for (let i = match.index + match[0].length - 1; i < scriptSource.length; i++) {
    const char = scriptSource[i];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('Unbalanced param() block');

  const block = scriptSource.slice(match.index, end);
  for (const varMatch of block.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    params.add(varMatch[1]);
  }
  return params;
}

function listScripts() {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((name) => name.endsWith('.ps1'))
    .map((name) => ({
      name,
      params: parseParamBlock(fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8')),
    }));
}

function listSourceFiles(dir) {
  const results = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}

/**
 * Finds every `<Script>.ps1` reference in a source file and collects the
 * `'-Flag'` string literals that follow it, up to the next script reference.
 *
 * Limitations: only statically resolvable references are checked. Dispatch
 * through a variable (HNSErrorRecovery uses `suggestion.scriptPath`) is not
 * attributed to a script and is therefore skipped, and a reference on a line
 * that holds nothing but the literal (main.js's ALLOWED_SCRIPTS array) is a
 * declaration rather than an invocation.
 */
const WHITELIST_ENTRY = /^['"]?(?:scripts\/)?[A-Za-z][A-Za-z0-9-]*\.ps1['"]?,?\s*(?:\/\/.*)?$/;
const MAX_REGION_LINES = 30;

function collectUsages(source, filePath) {
  const usages = [];
  const lines = source.split('\n');
  const scriptRefs = [...source.matchAll(/([A-Za-z][A-Za-z0-9-]*\.ps1)/g)];

  for (let i = 0; i < scriptRefs.length; i++) {
    const ref = scriptRefs[i];
    const lineNumber = source.slice(0, ref.index).split('\n').length;
    if (WHITELIST_ENTRY.test(lines[lineNumber - 1].trim())) continue;

    const start = ref.index + ref[0].length;
    const nextRef = i + 1 < scriptRefs.length ? scriptRefs[i + 1].index : source.length;
    const lineCap = lines.slice(0, lineNumber - 1 + MAX_REGION_LINES).join('\n').length;
    const end = Math.min(nextRef, lineCap, source.length);
    const region = source.slice(start, end);

    const flags = new Set();
    for (const flagMatch of region.matchAll(/['"](-[A-Za-z][A-Za-z0-9]*)['"]/g)) {
      const flag = flagMatch[1];
      if (POWERSHELL_HOST_FLAGS.has(flag)) continue;
      flags.add(flag);
    }

    if (flags.size > 0) {
      usages.push({
        script: ref[1],
        flags: [...flags],
        file: path.relative(REPO_ROOT, filePath),
        line: lineNumber,
      });
    }
  }

  return usages;
}

const scripts = listScripts();
const scriptsByName = new Map(scripts.map((s) => [s.name, s]));

const usages = SCANNED_DIRS.flatMap((dir) =>
  listSourceFiles(path.join(REPO_ROOT, dir)).flatMap((file) =>
    collectUsages(fs.readFileSync(file, 'utf8'), file)
  )
);

describe('PowerShell param block parsing', () => {
  it('finds the scripts', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(6);
  });

  it('parses declared parameters, including switches and validated params', () => {
    const deploy = scriptsByName.get('Deploy-BC-Container.ps1').params;
    expect(deploy).toContain('Version');
    expect(deploy).toContain('ContainerName');
    expect(deploy).toContain('InstallTestToolkit');
    expect(deploy).toContain('PasswordFile');
  });
});

describe('script argument contract', () => {
  it('finds the wizard and setup invocations it is meant to guard', () => {
    const scriptsUsed = usages.map((u) => u.script);
    expect(scriptsUsed).toContain('Deploy-BC-Container.ps1');
    expect(scriptsUsed).toContain('Install-BC-Helper.ps1');
  });

  it('passes only arguments the target script declares', () => {
    const violations = [];

    for (const usage of usages) {
      const script = scriptsByName.get(usage.script);
      if (!script) {
        violations.push(`${usage.file}:${usage.line} references unknown script ${usage.script}`);
        continue;
      }
      for (const flag of usage.flags) {
        if (!script.params.has(flag.slice(1))) {
          violations.push(
            `${usage.file}:${usage.line} passes ${flag} to ${usage.script}, which declares no such parameter`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it.each([
    ['Deploy-BC-Container.ps1', 'PasswordFile'],
    ['Install-BC-Helper.ps1', 'InstallModuleOnly'],
  ])('%s declares %s', (scriptName, param) => {
    expect(scriptsByName.get(scriptName).params).toContain(param);
  });
});

describe('main-process script whitelist', () => {
  const mainSource = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf8');
  const whitelisted = [...mainSource.matchAll(/'(scripts\/[A-Za-z0-9-]+\.ps1)'/g)].map((m) => m[1]);

  it('lists every bundled script', () => {
    for (const script of scripts) {
      expect(whitelisted).toContain(`scripts/${script.name}`);
    }
  });

  it('only whitelists scripts that exist on disk', () => {
    for (const entry of whitelisted) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry))).toBe(true);
    }
  });

  // 'cmd' was passed to powershell.run to launch Docker Desktop; the handler
  // resolved { exitCode: 1 } instead of rejecting and the caller reported
  // success. Launching now goes through a dedicated main-process handler.
  it('does not whitelist a general command runner', () => {
    expect(whitelisted).not.toContain('cmd');
    expect(mainSource).toContain("ipcMain.handle('docker:start-desktop'");
  });
});
