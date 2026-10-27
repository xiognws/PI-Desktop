"use strict";

/**
 * Node-facing entry point for the shared formatter. The implementation lives in
 * `views/lib/format.js` so the panel can load it with a plain script tag; this
 * re-export keeps a single copy of the rules for tests and scripts.
 */

module.exports = require("../../views/lib/format.js");
