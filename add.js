#!/usr/bin/env node
'use strict';
// `node add [name] [credentials.json [telemetry-state.json]]` - capture the
// login currently active in the ZCode desktop app.
const args = process.argv.slice(2);
require('./accounts.js').cmdAdd(args[0], args[1], args[2]);
