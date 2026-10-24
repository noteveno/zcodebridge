#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const { cmdList } = require('./cli/accounts');
cmdList();
