#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const { cmdLogin } = require('./cli/accounts');
cmdLogin(process.argv.slice(2)[0]);
