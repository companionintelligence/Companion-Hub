CREATE TABLE IF NOT EXISTS companion_message (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_companion_message_user_id ON companion_message(user_id);
CREATE INDEX idx_companion_message_created_at ON companion_message(created_at);
