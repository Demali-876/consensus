#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const command = process.argv[2];
const args = process.argv.slice(3);

const commands = {
  start: '../src/node-instance.js',
  register: '../src/register.js',
  test: '../src/tests/test-benchmark.js',
  help: null
};

function showHelp() {
  console.log(`
🌐 Consensus Node CLI

Usage: consensus-node <command>

Commands:
  start       Start the node server
  register    Register node with the network
  test        Run benchmark tests
  help        Show this help message

Examples:
  consensus-node start
  consensus-node register
  `);
}

if (!command || command === 'help' || !commands[command]) {
  showHelp();
  process.exit(command ? 0 : 1);
}

const scriptPath = resolve(__dirname, commands[command]);

const child = spawn('node', [scriptPath, ...args], {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code) => {
  process.exit(code);
});