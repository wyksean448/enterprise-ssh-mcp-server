import { readFile } from "node:fs/promises";
import { createServer, createConnection, type Server as NetServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type PseudoTtyOptions,
  type SFTPWrapper,
  type TcpConnectionDetails,
} from "ssh2";

import { ByteCollector, ShellRingBuffer, type WireEncoding } from "./buffers.js";
import { McpToolError } from "./tool-result.js";

export interface ConnectInput {
  name?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  agent?: string;
  agentForward: boolean;
  tryKeyboard: boolean;
  keyboardResponses: string[];
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  readyTimeoutMs: number;
  connectionTimeoutMs: number;
  hostHash?: string;
  expectedHostHash?: string;
  strictVendor: boolean;
  debug: boolean;
}

export interface SessionSummary {
  id: string;
  name?: string;
  host: string;
  port: number;
  username: string;
  connected: boolean;
  createdAt: string;
  lastUsedAt: string;
  shellCount: number;
  localTunnelCount: number;
  remoteTunnelCount: number;
  lastError?: string;
}

export interface ExecInput {
  command: string;
  env?: Record<string, string>;
  stdin?: string;
  stdinEncoding: WireEncoding;
  outputEncoding: WireEncoding;
  timeoutMs: number;
  maxOutputBytes: number;
  pty?: PseudoTtyOptions | boolean;
}

export interface ExecResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: ReturnType<ByteCollector["snapshot"]>;
  stderr: ReturnType<ByteCollector["snapshot"]>;
}

export interface ShellOpenInput {
  env?: Record<string, string>;
  allocatePty: boolean;
  pty?: PseudoTtyOptions;
  ringBufferBytes: number;
}

export interface ShellSummary {
  id: string;
  openedAt: string;
  lastUsedAt: string;
  closed: boolean;
  bufferedBytes: number;
  exitCode: number | null;
  exitSignal: string | null;
}

export interface ShellReadInput {
  shellId: string;
  maxBytes: number;
  encoding: WireEncoding;
  drain: boolean;
}

export interface LocalForwardInput {
  localHost: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
}

export interface RemoteForwardInput {
  remoteHost: string;
  remotePort: number;
  targetHost: string;
  targetPort: number;
}

export interface TunnelSummary {
  id: string;
  type: "local" | "remote";
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  openedAt: string;
  connectionCount: number;
  lastError?: string;
}

interface ShellRecord {
  id: string;
  channel: ClientChannel;
  buffer: ShellRingBuffer;
  openedAt: string;
  lastUsedAt: string;
  closed: boolean;
  exitCode: number | null;
  exitSignal: string | null;
}

interface LocalTunnelRecord {
  id: string;
  server: NetServer;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  openedAt: string;
  connectionCount: number;
  lastError?: string;
}

interface RemoteTunnelRecord {
  id: string;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  openedAt: string;
  connectionCount: number;
  lastError?: string;
}

interface RekeyCapableClient extends Client {
  rekey(callback?: () => void): void;
}

export class SshSession {
  public readonly id: string;
  private readonly client: Client;
  private readonly name?: string;
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly createdAt: string;
  private readonly shells = new Map<string, ShellRecord>();
  private readonly localTunnels = new Map<string, LocalTunnelRecord>();
  private readonly remoteTunnels = new Map<string, RemoteTunnelRecord>();
  private sftpPromise: Promise<SFTPWrapper> | undefined;
  private connected = false;
  private lastUsedAt: string;
  private lastError?: string;

  private constructor(id: string, input: ConnectInput, client: Client) {
    this.id = id;
    this.client = client;
    if (input.name !== undefined) {
      this.name = input.name;
    }
    this.host = input.host;
    this.port = input.port;
    this.username = input.username;
    this.createdAt = new Date().toISOString();
    this.lastUsedAt = this.createdAt;
    this.installConnectionEventHandlers();
  }

  public static async connect(input: ConnectInput): Promise<SshSession> {
    const client = new Client();
    const session = new SshSession(randomUUID(), input, client);
    await session.open(input);
    return session;
  }

  public summary(): SessionSummary {
    const summary: SessionSummary = {
      id: this.id,
      host: this.host,
      port: this.port,
      username: this.username,
      connected: this.connected,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      shellCount: this.shells.size,
      localTunnelCount: this.localTunnels.size,
      remoteTunnelCount: this.remoteTunnels.size,
    };
    if (this.name !== undefined) {
      summary.name = this.name;
    }
    if (this.lastError !== undefined) {
      summary.lastError = this.lastError;
    }
    return summary;
  }

  public async disconnect(): Promise<SessionSummary> {
    for (const shell of this.shells.values()) {
      shell.channel.close();
      shell.closed = true;
    }

    for (const tunnel of [...this.localTunnels.values()]) {
      await this.stopLocalTunnel(tunnel.id);
    }

    for (const tunnel of [...this.remoteTunnels.values()]) {
      await this.stopRemoteTunnel(tunnel.id);
    }

    if (this.sftpPromise !== undefined) {
      const sftp = await this.sftpPromise;
      sftp.end();
      this.sftpPromise = undefined;
    }

    await new Promise<void>((resolve) => {
      if (!this.connected) {
        resolve();
        return;
      }
      const timeout = setTimeout(resolve, 1_000);
      this.client.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.client.end();
    });

    this.connected = false;
    this.touch();
    return this.summary();
  }

  public async rekey(): Promise<object> {
    this.ensureConnected();
    const rekeyClient = this.client as Partial<RekeyCapableClient>;
    if (typeof rekeyClient.rekey !== "function") {
      throw new McpToolError("ssh_rekey_unsupported", "The installed ssh2 client does not expose a rekey method", {
        sessionId: this.id,
      });
    }

    await new Promise<void>((resolve, reject) => {
      rekeyClient.rekey?.(() => {
        resolve();
      });
      this.client.once("error", (err: Error) => {
        reject(new McpToolError("ssh_rekey_failed", err.message, { sessionId: this.id }));
      });
    });
    this.touch();
    return { ok: true, sessionId: this.id };
  }

  public exec(input: ExecInput): Promise<ExecResult> {
    this.ensureConnected();
    this.touch();
    const startedAt = Date.now();
    const stdout = new ByteCollector(input.maxOutputBytes);
    const stderr = new ByteCollector(input.maxOutputBytes);

    return new Promise((resolve, reject) => {
      const options = buildExecOptions(input);
      this.client.exec(input.command, options, (err: Error | null | undefined, channel: ClientChannel) => {
        if (err != null) {
          reject(new McpToolError("ssh_exec_open_failed", err.message, { sessionId: this.id, command: input.command }));
          return;
        }

        let exitCode: number | null = null;
        let signal: string | null = null;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          channel.close();
        }, input.timeoutMs);

        channel.on("data", (chunk: Buffer) => {
          stdout.append(chunk);
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          stderr.append(chunk);
        });
        channel.on("exit", (codeOrNull: number | null, signalName?: string) => {
          exitCode = codeOrNull;
          if (signalName !== undefined) {
            signal = signalName;
          }
        });
        channel.on("close", () => {
          clearTimeout(timeout);
          resolve({
            command: input.command,
            exitCode,
            signal,
            timedOut,
            durationMs: Date.now() - startedAt,
            stdout: stdout.snapshot(input.outputEncoding),
            stderr: stderr.snapshot(input.outputEncoding),
          });
        });
        channel.on("error", (streamError: Error) => {
          clearTimeout(timeout);
          reject(new McpToolError("ssh_exec_stream_failed", streamError.message, {
            sessionId: this.id,
            command: input.command,
          }));
        });

        if (input.stdin !== undefined) {
          const stdin = input.stdinEncoding === "base64" ? Buffer.from(input.stdin, "base64") : input.stdin;
          channel.end(stdin);
          return;
        }
        channel.eof();
      });
    });
  }

  public openShell(input: ShellOpenInput): Promise<ShellSummary> {
    this.ensureConnected();
    this.touch();
    return new Promise((resolve, reject) => {
      const window = input.allocatePty ? input.pty ?? {} : false;
      const options = input.env === undefined ? {} : { env: input.env };
      this.client.shell(window, options, (err: Error | null | undefined, channel: ClientChannel) => {
        if (err != null) {
          reject(new McpToolError("ssh_shell_open_failed", err.message, { sessionId: this.id }));
          return;
        }

        const shell: ShellRecord = {
          id: randomUUID(),
          channel,
          buffer: new ShellRingBuffer(input.ringBufferBytes),
          openedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          closed: false,
          exitCode: null,
          exitSignal: null,
        };

        channel.on("data", (chunk: Buffer) => {
          shell.buffer.append("stdout", chunk);
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          shell.buffer.append("stderr", chunk);
        });
        channel.on("exit", (codeOrNull: number | null, signalName?: string) => {
          shell.exitCode = codeOrNull;
          if (signalName !== undefined) {
            shell.exitSignal = signalName;
          }
        });
        channel.on("close", () => {
          shell.closed = true;
          shell.lastUsedAt = new Date().toISOString();
        });
        channel.on("error", (streamError: Error) => {
          shell.closed = true;
          this.lastError = streamError.message;
        });

        this.shells.set(shell.id, shell);
        resolve(this.shellSummary(shell));
      });
    });
  }

  public listShells(): ShellSummary[] {
    return [...this.shells.values()].map((shell) => this.shellSummary(shell));
  }

  public writeShell(shellId: string, data: string, encoding: WireEncoding): ShellSummary {
    const shell = this.getShell(shellId);
    if (shell.closed) {
      throw new McpToolError("ssh_shell_closed", "Shell channel is closed", { sessionId: this.id, shellId });
    }

    const payload = encoding === "base64" ? Buffer.from(data, "base64") : data;
    shell.channel.write(payload);
    shell.lastUsedAt = new Date().toISOString();
    this.touch();
    return this.shellSummary(shell);
  }

  public readShell(input: ShellReadInput): object {
    const shell = this.getShell(input.shellId);
    shell.lastUsedAt = new Date().toISOString();
    this.touch();
    return {
      shell: this.shellSummary(shell),
      output: shell.buffer.read(input.maxBytes, input.encoding, input.drain),
    };
  }

  public resizeShell(shellId: string, rows: number, cols: number, height: number, width: number): ShellSummary {
    const shell = this.getShell(shellId);
    if (shell.closed) {
      throw new McpToolError("ssh_shell_closed", "Shell channel is closed", { sessionId: this.id, shellId });
    }

    shell.channel.setWindow(rows, cols, height, width);
    shell.lastUsedAt = new Date().toISOString();
    this.touch();
    return this.shellSummary(shell);
  }

  public closeShell(shellId: string): ShellSummary {
    const shell = this.getShell(shellId);
    shell.channel.close();
    shell.closed = true;
    shell.lastUsedAt = new Date().toISOString();
    this.touch();
    return this.shellSummary(shell);
  }

  public getSftp(): Promise<SFTPWrapper> {
    this.ensureConnected();
    this.touch();
    if (this.sftpPromise !== undefined) {
      return this.sftpPromise;
    }

    this.sftpPromise = new Promise((resolve, reject) => {
      this.client.sftp((err: Error | null | undefined, sftp: SFTPWrapper) => {
        if (err != null) {
          this.sftpPromise = undefined;
          reject(new McpToolError("sftp_open_failed", err.message, { sessionId: this.id }));
          return;
        }

        sftp.on("error", (streamError: Error) => {
          this.lastError = streamError.message;
          this.sftpPromise = undefined;
        });
        sftp.on("end", () => {
          this.sftpPromise = undefined;
        });
        sftp.on("close", () => {
          this.sftpPromise = undefined;
        });
        resolve(sftp);
      });
    });

    return this.sftpPromise;
  }

  public startLocalForward(input: LocalForwardInput): Promise<TunnelSummary> {
    this.ensureConnected();
    this.touch();
    const tunnelId = randomUUID();
    const server = createServer((socket) => {
      const tunnel = this.localTunnels.get(tunnelId);
      if (tunnel === undefined) {
        socket.destroy();
        return;
      }
      this.handleLocalForwardConnection(tunnel, socket);
    });

    return new Promise((resolve, reject) => {
      server.once("error", (err: Error) => {
        reject(new McpToolError("local_forward_listen_failed", err.message, {
          sessionId: this.id,
          localHost: input.localHost,
          localPort: input.localPort,
        }));
      });
      server.listen(input.localPort, input.localHost, () => {
        const address = server.address();
        const bindPort = typeof address === "object" && address !== null ? address.port : input.localPort;
        const tunnel: LocalTunnelRecord = {
          id: tunnelId,
          server,
          bindHost: input.localHost,
          bindPort,
          targetHost: input.targetHost,
          targetPort: input.targetPort,
          openedAt: new Date().toISOString(),
          connectionCount: 0,
        };
        this.localTunnels.set(tunnel.id, tunnel);
        resolve(this.localTunnelSummary(tunnel));
      });
    });
  }

  public async startRemoteForward(input: RemoteForwardInput): Promise<TunnelSummary> {
    this.ensureConnected();
    this.touch();
    const bindPort = await new Promise<number>((resolve, reject) => {
      this.client.forwardIn(input.remoteHost, input.remotePort, (err: Error | null | undefined, port: number) => {
        if (err != null) {
          reject(new McpToolError("remote_forward_bind_failed", err.message, {
            sessionId: this.id,
            remoteHost: input.remoteHost,
            remotePort: input.remotePort,
          }));
          return;
        }
        resolve(port);
      });
    });

    const tunnel: RemoteTunnelRecord = {
      id: randomUUID(),
      bindHost: input.remoteHost,
      bindPort,
      targetHost: input.targetHost,
      targetPort: input.targetPort,
      openedAt: new Date().toISOString(),
      connectionCount: 0,
    };
    this.remoteTunnels.set(tunnel.id, tunnel);
    return this.remoteTunnelSummary(tunnel);
  }

  public listTunnels(): TunnelSummary[] {
    const local = [...this.localTunnels.values()].map((tunnel) => this.localTunnelSummary(tunnel));
    const remote = [...this.remoteTunnels.values()].map((tunnel) => this.remoteTunnelSummary(tunnel));
    return [...local, ...remote];
  }

  public async stopTunnel(tunnelId: string): Promise<TunnelSummary> {
    const localTunnel = this.localTunnels.get(tunnelId);
    if (localTunnel !== undefined) {
      const summary = this.localTunnelSummary(localTunnel);
      await this.stopLocalTunnel(tunnelId);
      return summary;
    }

    const remoteTunnel = this.remoteTunnels.get(tunnelId);
    if (remoteTunnel !== undefined) {
      const summary = this.remoteTunnelSummary(remoteTunnel);
      await this.stopRemoteTunnel(tunnelId);
      return summary;
    }

    throw new McpToolError("tunnel_not_found", "Tunnel id was not found", { sessionId: this.id, tunnelId });
  }

  private async open(input: ConnectInput): Promise<void> {
    const privateKey = await loadPrivateKey(input);
    const config = buildConnectConfig(input, privateKey);

    if (input.tryKeyboard) {
      this.client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        finish(input.keyboardResponses.slice(0, prompts.length));
      });
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new McpToolError("ssh_connect_failed", err.message, {
          host: input.host,
          port: input.port,
          username: input.username,
        }));
      };
      const ready = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.connected = true;
        resolve();
      };
      const closedBeforeReady = (): void => {
        fail(new Error("SSH connection closed before ready"));
      };
      const cleanup = (): void => {
        this.client.off("ready", ready);
        this.client.off("error", fail);
        this.client.off("close", closedBeforeReady);
      };

      this.client.once("ready", ready);
      this.client.once("error", fail);
      this.client.once("close", closedBeforeReady);
      this.client.connect(config);
    });
  }

  private installConnectionEventHandlers(): void {
    this.client.on("error", (err: Error) => {
      this.lastError = err.message;
    });
    this.client.on("close", () => {
      this.connected = false;
      for (const shell of this.shells.values()) {
        shell.closed = true;
      }
      this.sftpPromise = undefined;
    });
    this.client.on("tcp connection", (details, accept, reject) => {
      this.handleRemoteForwardConnection(details, accept, reject);
    });
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new McpToolError("ssh_session_not_connected", "SSH session is not connected", { sessionId: this.id });
    }
  }

  private touch(): void {
    this.lastUsedAt = new Date().toISOString();
  }

  private getShell(shellId: string): ShellRecord {
    const shell = this.shells.get(shellId);
    if (shell === undefined) {
      throw new McpToolError("ssh_shell_not_found", "Shell id was not found", { sessionId: this.id, shellId });
    }
    return shell;
  }

  private shellSummary(shell: ShellRecord): ShellSummary {
    return {
      id: shell.id,
      openedAt: shell.openedAt,
      lastUsedAt: shell.lastUsedAt,
      closed: shell.closed,
      bufferedBytes: shell.buffer.size(),
      exitCode: shell.exitCode,
      exitSignal: shell.exitSignal,
    };
  }

  private handleLocalForwardConnection(tunnel: LocalTunnelRecord, socket: Socket): void {
    tunnel.connectionCount += 1;
    this.client.forwardOut(
      socket.remoteAddress ?? "127.0.0.1",
      socket.remotePort ?? 0,
      tunnel.targetHost,
      tunnel.targetPort,
      (err: Error | null | undefined, channel: ClientChannel) => {
        if (err != null) {
          tunnel.lastError = err.message;
          socket.destroy(err);
          return;
        }
        socket.pipe(channel).pipe(socket);
        channel.on("error", (streamError: Error) => {
          tunnel.lastError = streamError.message;
          socket.destroy(streamError);
        });
      },
    );
  }

  private handleRemoteForwardConnection(
    details: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void,
  ): void {
    const tunnel = [...this.remoteTunnels.values()].find((candidate) => candidate.bindPort === details.destPort);
    if (tunnel === undefined) {
      reject();
      return;
    }

    const channel = accept();
    const socket = createConnection({ host: tunnel.targetHost, port: tunnel.targetPort });
    tunnel.connectionCount += 1;
    channel.pipe(socket).pipe(channel);
    socket.on("error", (err: Error) => {
      tunnel.lastError = err.message;
      channel.destroy();
    });
    channel.on("error", (err: Error) => {
      tunnel.lastError = err.message;
      socket.destroy(err);
    });
  }

  private async stopLocalTunnel(tunnelId: string): Promise<void> {
    const tunnel = this.localTunnels.get(tunnelId);
    if (tunnel === undefined) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      tunnel.server.close((err?: Error) => {
        if (err !== undefined) {
          reject(new McpToolError("local_forward_close_failed", err.message, { sessionId: this.id, tunnelId }));
          return;
        }
        resolve();
      });
    });
    this.localTunnels.delete(tunnelId);
  }

  private async stopRemoteTunnel(tunnelId: string): Promise<void> {
    const tunnel = this.remoteTunnels.get(tunnelId);
    if (tunnel === undefined) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.client.unforwardIn(tunnel.bindHost, tunnel.bindPort, (err: Error | null | undefined) => {
        if (err != null) {
          reject(new McpToolError("remote_forward_close_failed", err.message, { sessionId: this.id, tunnelId }));
          return;
        }
        resolve();
      });
    });
    this.remoteTunnels.delete(tunnelId);
  }

  private localTunnelSummary(tunnel: LocalTunnelRecord): TunnelSummary {
    const summary: TunnelSummary = {
      id: tunnel.id,
      type: "local",
      bindHost: tunnel.bindHost,
      bindPort: tunnel.bindPort,
      targetHost: tunnel.targetHost,
      targetPort: tunnel.targetPort,
      openedAt: tunnel.openedAt,
      connectionCount: tunnel.connectionCount,
    };
    if (tunnel.lastError !== undefined) {
      summary.lastError = tunnel.lastError;
    }
    return summary;
  }

  private remoteTunnelSummary(tunnel: RemoteTunnelRecord): TunnelSummary {
    const summary: TunnelSummary = {
      id: tunnel.id,
      type: "remote",
      bindHost: tunnel.bindHost,
      bindPort: tunnel.bindPort,
      targetHost: tunnel.targetHost,
      targetPort: tunnel.targetPort,
      openedAt: tunnel.openedAt,
      connectionCount: tunnel.connectionCount,
    };
    if (tunnel.lastError !== undefined) {
      summary.lastError = tunnel.lastError;
    }
    return summary;
  }
}

async function loadPrivateKey(input: ConnectInput): Promise<string | undefined> {
  if (input.privateKey !== undefined) {
    return input.privateKey;
  }

  if (input.privateKeyPath === undefined) {
    return undefined;
  }

  return readFile(input.privateKeyPath, "utf8");
}

function buildConnectConfig(input: ConnectInput, privateKey: string | undefined): ConnectConfig {
  const config: ConnectConfig = {
    host: input.host,
    port: input.port,
    username: input.username,
    agentForward: input.agentForward,
    tryKeyboard: input.tryKeyboard,
    keepaliveInterval: input.keepaliveIntervalMs,
    keepaliveCountMax: input.keepaliveCountMax,
    readyTimeout: input.readyTimeoutMs,
    timeout: input.connectionTimeoutMs,
    strictVendor: input.strictVendor,
  };

  if (input.password !== undefined) {
    config.password = input.password;
  }
  if (privateKey !== undefined) {
    config.privateKey = privateKey;
  }
  if (input.passphrase !== undefined) {
    config.passphrase = input.passphrase;
  }
  if (input.agent !== undefined) {
    config.agent = input.agent;
  }
  if (input.hostHash !== undefined) {
    config.hostHash = input.hostHash;
  }
  if (input.expectedHostHash !== undefined) {
    config.hostVerifier = (hashedKey: string): boolean => {
      return hashedKey.toLowerCase() === input.expectedHostHash?.toLowerCase();
    };
  }
  if (input.debug) {
    config.debug = (message: string): void => {
      process.stderr.write(`[ssh2] ${message}\n`);
    };
  }

  return config;
}

function buildExecOptions(input: ExecInput): { env?: NodeJS.ProcessEnv; pty?: PseudoTtyOptions | boolean } {
  const options: { env?: NodeJS.ProcessEnv; pty?: PseudoTtyOptions | boolean } = {};
  if (input.env !== undefined) {
    options.env = input.env;
  }
  if (input.pty !== undefined) {
    options.pty = input.pty;
  }
  return options;
}
