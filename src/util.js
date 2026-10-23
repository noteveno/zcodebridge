'use strict';

// Small shared helpers with no dependencies of their own.

const fs = require('node:fs');
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, code = 'proxy_error', type = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSessionId() {
  return `session_${crypto.randomUUID()}`;
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

module.exports = {
  HttpError,
  readJsonIfExists,
  firstDefined,
  sleep,
  makeSessionId,
  readResponseText,
};
