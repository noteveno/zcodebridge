#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const { cmdAdd } = require('./cli/accounts');
const args = process.argv.slice(2); cmdAdd(args[0], args[1], args[2]);
