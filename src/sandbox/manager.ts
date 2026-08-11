import crypto from "node:crypto";
import { execa } from "execa";
import { logger } from "../utils/logger.js";

export interface SandboxConfig {
  enabled: boolean;
  level: "strict" | "standard" | "permissive";
  image: string;
  timeoutMs: number;
  maxMemoryMb: number;
  allowNetwork: boolean;
  persistent: boolean;
  pidsLimit: number;
  fallbackToHost: boolean;
}

export interface SandboxRuntimeOptions {
  workspaceId?: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  all: string;
  exitCode: number;
  timedOut: boolean;
}

const MAX_OUTPUT_BYTES = 100_000;

/**
 * Docker execution backend for model-generated commands.
 *
 * Persistent mode keeps one hardened container per task, allowing package
 * installs, background state and generated files to survive between commands.
 * The selected workspace is the only host path mounted into the container.
 */
export class SandboxManager {
  private available: boolean | null = null;
  private containerName?: string;
  private ensurePromise?: Promise<void>;

  constructor(
    private readonly config: SandboxConfig,
    private readonly runtime: SandboxRuntimeOptions = {},
  ) {}

  get fallbackToHost(): boolean {
    return this.config.fallbackToHost;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await execa("docker", ["info", "--format", "{{.ServerVersion}}"], {
        timeout: 5_000,
        reject: true,
        stdio: "pipe",
      });
      this.available = true;
      logger.debug("sandbox.docker_available");
    } catch {
      this.available = false;
      logger.debug("sandbox.docker_unavailable");
    }
    return this.available;
  }

  async run(command: string, cwd: string, signal?: AbortSignal): Promise<SandboxResult> {
    const mountPath = this.toDockerPath(cwd);
    const args = this.config.persistent
      ? await this.buildPersistentExecArgs(command, mountPath)
      : this.buildArgs(command, mountPath);

    logger.debug("sandbox.run", {
      command,
      mountPath,
      level: this.config.level,
      image: this.config.image,
      persistent: this.config.persistent,
      containerName: this.containerName,
    });

    try {
      const result = await execa("docker", args, {
        timeout: this.config.timeoutMs,
        reject: false,
        all: true,
        maxBuffer: MAX_OUTPUT_BYTES,
        cancelSignal: signal,
        stdio: "pipe",
      });
      const combined = result.all ?? (result.stdout + result.stderr);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        all: combined,
        exitCode: result.exitCode ?? 1,
        timedOut: false,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) {
        return {
          stdout: "",
          stderr: "Command timed out",
          all: "Command timed out",
          exitCode: 124,
          timedOut: true,
        };
      }
      throw error;
    }
  }

  /** Build a hardened one-shot command for environments that disable persistence. */
  buildArgs(command: string, mountPath: string): string[] {
    const { readOnlySuffix, network } = this.executionPolicy();
    return [
      "run",
      "--rm",
      ...this.securityArgs(mountPath, readOnlySuffix, network),
      this.config.image,
      "sh",
      "-c",
      command,
    ];
  }

  /** Explicit cleanup hook; never removes containers that AllyCode did not name. */
  async destroy(): Promise<void> {
    if (!this.containerName) return;
    await execa("docker", ["rm", "--force", this.containerName], {
      timeout: 15_000,
      reject: false,
      stdio: "pipe",
    });
    this.containerName = undefined;
    this.ensurePromise = undefined;
  }

  toDockerPath(value: string): string {
    if (value.startsWith("/")) return value;
    const match = /^([a-zA-Z]):[\\/]?(.*)/.exec(value);
    if (match?.[1] && match[2] !== undefined) {
      return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
    }
    return value.replace(/\\/g, "/");
  }

  private async buildPersistentExecArgs(
    command: string,
    mountPath: string,
  ): Promise<string[]> {
    await this.ensurePersistentContainer(mountPath);
    return [
      "exec",
      "--workdir",
      "/workspace",
      this.containerName!,
      "sh",
      "-c",
      command,
    ];
  }

  private async ensurePersistentContainer(mountPath: string): Promise<void> {
    this.containerName ??= this.makeContainerName(mountPath);
    this.ensurePromise ??= this.startOrCreateContainer(this.containerName, mountPath);
    await this.ensurePromise;
  }

  private async startOrCreateContainer(name: string, mountPath: string): Promise<void> {
    const inspected = await execa(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", name],
      { timeout: 8_000, reject: false, stdio: "pipe" },
    );
    if (inspected.exitCode === 0 && inspected.stdout.trim() === "true") return;
    if (inspected.exitCode === 0) {
      const started = await execa("docker", ["start", name], {
        timeout: 15_000,
        reject: false,
        stdio: "pipe",
      });
      if (started.exitCode === 0) return;
      throw new Error(`Unable to start AllyCode sandbox '${name}': ${started.stderr}`);
    }

    const { readOnlySuffix, network } = this.executionPolicy();
    const created = await execa("docker", [
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      "com.allycode.managed=true",
      ...this.securityArgs(mountPath, readOnlySuffix, network),
      this.config.image,
      "sh",
      "-c",
      "while true; do sleep 3600; done",
    ], {
      timeout: 120_000,
      reject: false,
      stdio: "pipe",
    });
    if (created.exitCode !== 0) {
      throw new Error(`Unable to create AllyCode sandbox: ${created.stderr || created.stdout}`);
    }
  }

  private executionPolicy(): { readOnlySuffix: string; network: string } {
    return {
      readOnlySuffix: this.config.level === "strict" ? ":ro" : "",
      network:
        this.config.level === "strict"
          ? "none"
          : this.config.allowNetwork ? "bridge" : "none",
    };
  }

  private securityArgs(
    mountPath: string,
    readOnlySuffix: string,
    network: string,
  ): string[] {
    return [
      "-v",
      `${mountPath}:/workspace${readOnlySuffix}`,
      "-w",
      "/workspace",
      "--network",
      network,
      "--memory",
      `${this.config.maxMemoryMb}m`,
      "--cpus",
      "1",
      "--pids-limit",
      String(this.config.pidsLimit),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--tmpfs",
      "/home/node:rw,nosuid,nodev,size=256m",
      "--user",
      "1000:1000",
      "--init",
      "--interactive=false",
    ];
  }

  private makeContainerName(mountPath: string): string {
    const profile = JSON.stringify({
      identity: this.runtime.workspaceId ?? mountPath,
      image: this.config.image,
      level: this.config.level,
      network: this.config.allowNetwork,
      memory: this.config.maxMemoryMb,
      pids: this.config.pidsLimit,
    });
    const digest = crypto.createHash("sha256").update(profile).digest("hex").slice(0, 16);
    return `allycode-task-${digest}`;
  }
}
