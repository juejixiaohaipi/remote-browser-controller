#!/bin/bash
# Start Playwright relay — reads .env for configuration
cd "$(dirname "$0")"
set -a
source .env
set +a
node playwright-relay.js
