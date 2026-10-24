#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const { cmdUsage } = require('./cli/accounts');
cmdUsage();
