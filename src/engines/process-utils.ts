import { execa, type ResultPromise } from "execa";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
}

export async function runEngineCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; reject?: boolean } = {},
): Promise<CommandResult> {
  const result = await execa(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 5_000,
    reject: options.reject ?? false,
    shell: false,
    windowsHide: true,
    env: sanitizedChildEnvironment(),
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    failed: result.failed,
    timedOut: result.timedOut,
  };
}

export function startEngineCommand(
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
): ResultPromise {
  return execa(command, args, {
    cwd: options.cwd,
    reject: false,
    shell: false,
    windowsHide: true,
    signal: options.signal,
    cancelSignal: options.signal,
    env: sanitizedChildEnvironment(),
  });
}

function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Packaged Electron launchers may inherit this flag from developer shells.
  // It must not leak into third-party Node/Electron executables.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
