#!/usr/bin/env node
'use strict';
// `node auth` - add a Z.ai account (interactive OAuth login).
require('./accounts.js').cmdLogin(process.argv.slice(2)[0]);
