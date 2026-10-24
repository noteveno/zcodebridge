#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
require('./cli/accounts');
require('./cli/accounts').run(process.argv[2], process.argv.slice(3));
