// Route classing and own-row scoping (CTL-AUTHZ-01). Every route the
// router registers carries exactly one class; an unclassed route is
// refused. requireRole() and scopeToOwnRow() are the one helper each
// handler calls -- a handler never writes its own "is this mine?" check.

export const ROUTE_CLASSES = Object.freeze(["public", "own", "staff-own", "owner"]);

// session: the loaded session row (or null). account: the loaded
// account row (or null). routeClass: one of ROUTE_CLASSES.
export function authorize(routeClass, session, account) {
  if (!ROUTE_CLASSES.includes(routeClass)) return { ok: false, status: 403, error: "route_unclassed" };
  if (routeClass === "public") return { ok: true };
  if (!session || !account) return { ok: false, status: 401, error: "not_authenticated" };
  if (routeClass === "owner") {
    return account.role === "owner" ? { ok: true } : { ok: false, status: 403, error: "owner_only" };
  }
  if (routeClass === "staff-own") {
    return account.role === "staff" || account.role === "owner" ? { ok: true } : { ok: false, status: 403, error: "staff_only" };
  }
  // "own": any authenticated role may reach the route; the handler must
  // still scope its query to this account via scopeToOwnRow/ownAccountId.
  return { ok: true };
}

// A single helper every "own" query goes through (CTL-AUTHZ-01): appends
// `AND <column> = ?` bound to the session's account id. Returns the
// clause and the extra binding to splice onto the caller's own params.
export function ownRowClause(column = "account_id") {
  return `AND ${column} = ?`;
}

// CTL-ROLE-02: no endpoint may ever set role = 'owner'. Call this before
// building any account-write field list; it strips `role` entirely
// unless the caller is the login flow itself (auth.js), which never
// calls this helper.
export function stripPrivilegedFields(input) {
  const { role, is_demo, email, credits, stripe_customer_id, ...safe } = input || {};
  return safe;
}

// CTL-AUTHZ-02: dependants are visible only to the household (the
// account they are attached to) and the owner.
export function canReadDependant(dependant, requester) {
  if (!requester) return false;
  if (requester.role === "owner") return true;
  return requester.id === dependant.household_account_id;
}
