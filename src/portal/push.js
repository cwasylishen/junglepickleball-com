// Interface stub for B2e (amendment 6). B1 commits this module with the
// exact export signature below as a working, non-throwing stub so
// cron.js's import resolves and `npm test` stays green while B2e writes
// the real body. From here on this file belongs to B2e -- it replaces
// this stub outright with the 24h/2h reminder sends, deduplicated via
// `reminder_sends` (docs/portal/api.md §8, CTL-PSH-01).

export async function sendDueReminders(env) {
  return { sent: 0 };
}
