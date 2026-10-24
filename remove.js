#!/usr/bin/env node
'use strict';
// `node remove <name>` - delete a stored account.
require('./accounts.js').cmdRemove(process.argv.slice(2)[0]);
