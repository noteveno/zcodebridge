#!/usr/bin/env node
'use strict';
// `node claim [name]` - claim any free plan Z.ai offers the account.
require('./accounts.js').cmdClaim(process.argv.slice(2)[0]);
