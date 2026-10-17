- A channel whose descriptor carries `metadata.speech: 'none'` (terminal-sessions marks
  its session channels so) is never the automatic destination of an agent's prose: a turn
  that such a channel woke routes bare prose to the agent's home or default channel
  instead, the agent is told that channel, and the terminal channel is not opened by
  delivery. Explicit sends to it still work.
