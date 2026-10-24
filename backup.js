#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const { runBackup } = require('./cli/backup');
runBackup();
