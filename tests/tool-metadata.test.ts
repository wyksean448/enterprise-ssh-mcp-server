import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_NAMES,
  DANGEROUS_TOOL_NAMES,
  LOCAL_ONLY_TOOL_NAMES,
  TOOL_NAMES,
  TOOL_RISK,
  resolveToolAnnotations,
} from "../src/tools/tool-metadata.js";

describe("MCP tool risk metadata", () => {
  it("defines a unique risk category for every registered public tool", () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    expect(Object.keys(TOOL_RISK).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("marks arbitrary remote command and write operations as destructive", () => {
    for (const name of [
      "ssh_run_profile",
      "ssh_run_openssh",
      "ssh_run_openssh_temporary",
      "ssh_exec",
      "ssh_shell_write",
      "ssh_file_patch",
      "ssh_project_apply_patch",
      "ssh_edit_rollback",
      "sftp_write_file",
      "sftp_rm",
      "sftp_upload_start",
      "sftp_download_start",
    ]) {
      expect(resolveToolAnnotations(name, undefined).destructiveHint, name).toBe(true);
      expect(resolveToolAnnotations(name, undefined).readOnlyHint, name).toBe(false);
    }
  });

  it("does not mark stateful but non-destructive tools as read-only or destructive", () => {
    for (const name of [
      "ssh_connect",
      "ssh_disconnect",
      "ssh_shell_open",
      "ssh_tunnel_local_start",
      "ssh_tunnel_remote_start",
      "sftp_mkdir",
      "sftp_touch",
      "sftp_symlink",
    ]) {
      const annotations = resolveToolAnnotations(name, undefined);
      expect(annotations.readOnlyHint, name).toBe(false);
      expect(annotations.destructiveHint, name).toBe(false);
    }
  });

  it("marks local reads as read-only and keeps world-access hints accurate", () => {
    const localRead = resolveToolAnnotations("ssh_get_config", undefined);
    expect(localRead.readOnlyHint).toBe(true);
    expect(localRead.openWorldHint).toBe(false);

    const remoteRead = resolveToolAnnotations("sftp_read_file", undefined);
    expect(remoteRead.readOnlyHint).toBe(true);
    expect(remoteRead.openWorldHint).toBe(true);

    const hostKeyProbe = resolveToolAnnotations("ssh_probe_host_key", undefined);
    expect(hostKeyProbe.readOnlyHint).toBe(true);
    expect(hostKeyProbe.destructiveHint).toBe(false);
    expect(hostKeyProbe.openWorldHint).toBe(true);

    const hostCaTrust = resolveToolAnnotations("ssh_trust_host_ca", undefined);
    expect(hostCaTrust.readOnlyHint).toBe(false);
    expect(hostCaTrust.destructiveHint).toBe(false);

    expect(resolveToolAnnotations("sftp_download_start", undefined).readOnlyHint).toBe(false);
    expect(LOCAL_ONLY_TOOL_NAMES.has("sftp_transfer_status")).toBe(true);
  });

  it("preserves the existing tool exposure sets independently from risk classification", () => {
    expect(AGENT_TOOL_NAMES.has("ssh_exec")).toBe(true);
    expect(AGENT_TOOL_NAMES.has("ssh_run_openssh")).toBe(true);
    expect(AGENT_TOOL_NAMES.has("ssh_run_openssh_temporary")).toBe(true);
    expect(AGENT_TOOL_NAMES.has("ssh_trust_host_ca")).toBe(true);
    expect(DANGEROUS_TOOL_NAMES.has("sftp_rm")).toBe(true);
    expect(DANGEROUS_TOOL_NAMES.has("ssh_exec")).toBe(false);
  });

  it("fails closed if a newly registered tool has no explicit risk metadata", () => {
    expect(() => resolveToolAnnotations("ssh_unclassified_future_tool", undefined)).toThrow(
      /Missing explicit risk metadata/,
    );
  });
});
