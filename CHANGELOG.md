# Changelog

## 0.3.2 - 2026-10-25

- Refactor MCP tool registration into domain-focused modules while preserving the stdio entry point and existing tool names.
- Add one-shot native OpenSSH execution and temporary host-CA trust for OpenSSH host-certificate endpoints, with fail-closed local fingerprint pinning and cleanup of temporary trust files.
- Add host-key/CA probing and an explicit CA trust workflow that checks against a locally configured pin.
- Add atomic .env hot reload for runtime defaults and SSH profiles; invalid or partial edits keep the last valid snapshot.
- Redact InstaBox bearer-token usernames from public profile/session results and SSH debug output.
- Add regression coverage for target validation, host CA parsing, temporary OpenSSH execution/cleanup, and configuration reload.
- Add a local PowerShell MCP end-to-end test harness. It is maintained in the source repository and is intentionally excluded from the npm package.
