#!/usr/bin/env node
'use strict';

// Thin wrapper - the implementation lives in cli/.
const { setup } = require('./cli/setup');
setup();
