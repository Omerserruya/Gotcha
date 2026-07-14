// Debug preload: stop Node's console/util.inspect from truncating deep objects
// to `[Array]` / `[Object]`. Loaded via NODE_OPTIONS=--require so the OpenAI
// SDK's OPENAI_LOG=debug output prints the FULL request body (system prompt,
// messages, tool schemas). Debug-only - not loaded in normal operation.
const util = require("util");
util.inspect.defaultOptions.depth = null;
util.inspect.defaultOptions.maxArrayLength = null;
util.inspect.defaultOptions.maxStringLength = null;
util.inspect.defaultOptions.breakLength = 120;
