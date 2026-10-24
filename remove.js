#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const { cmdRemove } = require('./cli/accounts');
cmdRemove(process.argv.slice(2)[0]);
