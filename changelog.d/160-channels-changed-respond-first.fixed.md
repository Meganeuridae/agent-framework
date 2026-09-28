- `channels/changed` is answered before the host reconciles the added
  channels, as `channels/register` already was (#160). Reconciling sends
  `channels/open` or `channels/close` back to the server, and a server that
  announced from inside a request it was serving (a tool that refreshes or
  subscribes) could not read them until its announcement was answered, so
  both sides waited until one timed out. In zulip-mcp this left streams the
  bot joined after startup as `Unknown channel` until a restart.
