import { afterEach, describe, expect, it } from "vitest";

import {
  getTrustedHostCaFingerprint,
  hostCaTrustKey,
  TRUSTED_HOST_CA_FINGERPRINTS_ENV,
} from "../src/host-ca-trust-config.js";

const fingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

afterEach(() => {
  delete process.env[TRUSTED_HOST_CA_FINGERPRINTS_ENV];
});

describe("local host CA trust pins", () => {
  it("normalizes host names and requires the exact host and port entry", () => {
    const environment = {
      [TRUSTED_HOST_CA_FINGERPRINTS_ENV]: JSON.stringify({
        "ssh.instabox.sh:2222": fingerprint,
        "[2001:db8::1]:2222": fingerprint,
      }),
    } as NodeJS.ProcessEnv;

    expect(hostCaTrustKey("SSH.INSTABOX.SH", 2222)).toBe("ssh.instabox.sh:2222");
    expect(getTrustedHostCaFingerprint("SSH.INSTABOX.SH", 2222, environment)).toBe(fingerprint);
    expect(getTrustedHostCaFingerprint("2001:db8::1", 2222, environment)).toBe(fingerprint);
    expect(() => getTrustedHostCaFingerprint("ssh.instabox.sh", 22, environment)).toThrowError(
      expect.objectContaining({ code: "ssh_host_ca_not_configured" }),
    );
  });

  it("fails closed when no trust pin is configured", () => {
    expect(() => getTrustedHostCaFingerprint("ssh.instabox.sh", 2222, {})).toThrowError(
      expect.objectContaining({ code: "ssh_host_ca_not_configured" }),
    );
  });

  it("rejects malformed JSON and malformed fingerprints", () => {
    expect(() => getTrustedHostCaFingerprint("ssh.instabox.sh", 2222, {
      [TRUSTED_HOST_CA_FINGERPRINTS_ENV]: "{",
    })).toThrowError(expect.objectContaining({ code: "ssh_host_ca_config_invalid" }));

    expect(() => getTrustedHostCaFingerprint("ssh.instabox.sh", 2222, {
      [TRUSTED_HOST_CA_FINGERPRINTS_ENV]: JSON.stringify({ "ssh.instabox.sh:2222": "SHA256:not-a-fingerprint" }),
    })).toThrowError(expect.objectContaining({ code: "ssh_host_ca_config_invalid" }));
  });
});
