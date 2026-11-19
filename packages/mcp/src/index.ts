#!/usr/bin/env node
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FileTokenStore, FrameTV, type Logger } from 'swiftframe-core';
import { createServer } from './server.js';

const host = process.env.SWIFTFRAME_HOST?.trim();

if (!host) {
  console.error('swiftframe-mcp: set SWIFTFRAME_HOST to the IP address of your TV.');
  process.exit(1);
}

// stdout carries the MCP protocol, so all logging goes to stderr.
const verbose = process.env.SWIFTFRAME_DEBUG === '1';
const logger: Logger = {
  debug: (message) => verbose && console.error(`[debug] ${message}`),
  info: (message) => console.error(`[info] ${message}`),
  warn: (message) => console.error(`[warn] ${message}`),
  error: (message) => console.error(`[error] ${message}`),
};

const tokenFile =
  process.env.SWIFTFRAME_TOKEN_FILE?.trim() || join(homedir(), '.swiftframe', `${host.replace(/[^a-zA-Z0-9.-]/g, '_')}.token`);

const tv = new FrameTV({
  host,
  mac: process.env.SWIFTFRAME_MAC?.trim() || undefined,
  clientName: process.env.SWIFTFRAME_CLIENT_NAME?.trim() || 'Claude',
  tokenStore: new FileTokenStore(tokenFile),
  logger,
});

const uploadDirs = process.env.SWIFTFRAME_UPLOAD_DIRS?.split(delimiter)
  .map((dir) => dir.trim())
  .filter(Boolean);

const server = createServer(tv, { uploadDirs });

const shutdown = () => {
  tv.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
logger.info(`swiftframe-mcp ready for the TV at ${host}`);
