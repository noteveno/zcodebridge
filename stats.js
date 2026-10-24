#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const { showStats } = require('./cli/stats');
showStats();
