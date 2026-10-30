-- DRAFT FOR ROGER: the displayed cancellation policy is intentionally
-- reviewable before release. Store acknowledgement on each booking.
ALTER TABLE bookings ADD COLUMN policy_acknowledged_at TEXT;
