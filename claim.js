#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const { cmdClaim } = require('./cli/accounts');
cmdClaim(process.argv.slice(2)[0]);
