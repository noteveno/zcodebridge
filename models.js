#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const models = require('./cli/models');
const command = process.argv[2] || 'list'; if (command === 'check') models.checkOnce(); else if (command === 'watch') models.watch(); else models.list();
