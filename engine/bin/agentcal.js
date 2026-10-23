#!/usr/bin/env node
// Thin gate, NO src imports here: the app uses node:sqlite, which only
// exists unflagged on Node 22.13+ / 23.4+. On anything older the import
// chain dies with a cryptic ERR_UNKNOWN_BUILTIN_MODULE before argv is even
// read — so check the version first and fail with an answer, not a trace.
const [major, minor] = process.versions.node.split('.').map(Number)
const supported = major >= 24 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13)
if (!supported) {
  console.error(`agentcalendar needs Node 22.13 or newer (it uses Node's built-in SQLite).
You're running Node ${process.versions.node}.

  Fix: install the current LTS from https://nodejs.org
       or: nvm install 22 && nvm use 22   ·   brew upgrade node
`)
  process.exit(1)
}
await import('./main.js')
