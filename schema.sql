CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,          -- 텔레그램 수신자
  message    TEXT    NOT NULL,          -- 보낼 내용
  cron       TEXT    NOT NULL,          -- '0 9 * * *' (분 시 일 월 요일)
  timezone   TEXT    NOT NULL DEFAULT 'Asia/Seoul',
  once_at    TEXT,                      -- 일회성 알람이면 'YYYY-MM-DDTHH:mm' (해당 tz 기준)
  last_sent  TEXT,                      -- 중복 발송 방지용 마지막 발송 분
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 매 분 스캔하므로 enabled 기준 조회를 빠르게
CREATE INDEX IF NOT EXISTS idx_reminders_enabled ON reminders(enabled);
