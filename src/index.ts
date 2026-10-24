#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app/create-app.js";

const app = createApp();
await app.server.connect(new StdioServerTransport());

process.once("SIGINT", () => {
  void app.shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void app.shutdown().finally(() => process.exit(0));
});
