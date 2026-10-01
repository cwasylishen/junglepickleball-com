// Interface stub for B2d (amendment 6). B1 commits this module with the
// exact export signature below as a working, non-throwing stub so every
// other part's import resolves and `npm test` stays green while B2d
// writes the real body. From here on this file belongs to B2d -- it
// replaces this stub outright with the one-way push that drains
// `calendar_outbox` (docs/portal/api.md §7).

export async function drainCalendarOutbox(env, { limit = 25 } = {}) {
  return { configured: false, skipped: 0, sent: 0, failed: 0 };
}
