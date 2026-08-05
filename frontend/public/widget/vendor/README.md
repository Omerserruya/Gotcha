# Vendored widget dependencies

## `socket.io.min.js`

Verbatim copy of `socket.io-client@4.8.3`'s browser build
(`node_modules/socket.io-client/dist/socket.io.min.js`), with only the
trailing `sourceMappingURL` comment removed so a storefront's devtools
does not 404 on a map we do not ship.

**Why a copy rather than a bundle step.** The storefront widget has no
build pipeline on purpose: it ships as plain files from `public/`, which
is what keeps its bootstrap small enough to sit on every page of a
merchant's store without a bundler in the way.

**Why socket.io at all.** The visitor rides the same transport the inbox
uses (see `services/conversation/src/lib/socket.ts`), which is what makes
an agent's reply appear instantly instead of on a poll tick, and gives us
socket.io's reconnection and backoff for free rather than hand-rolling
them. It is loaded **lazily** - only when a shopper opens the chat, or
when a returning shopper already has a conversation in progress - so a
visitor who never opens the widget never downloads it.

There is a polling fallback for when this file cannot load or the socket
cannot connect, so the chat degrades rather than breaks.

**Upgrading.** Re-run the copy when `socket.io-client` is upgraded in
`frontend/package.json`, and update the version recorded above:

```sh
sed 's|//# sourceMappingURL=socket.io.min.js.map||' \
  frontend/node_modules/socket.io-client/dist/socket.io.min.js \
  > frontend/public/widget/vendor/socket.io.min.js
```
