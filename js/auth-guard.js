// RUCUSO — RucusoGuard
//
// Loaded on every /leader/* and /admin/* page, right after
// /supabase/config.js and /supabase/supabase-client.js. Nothing sensitive on
// those pages should render before requireRole() resolves — this is a UX/
// architecture boundary (spec item 17), not the real security boundary.
// The real boundary is Supabase RLS: even if someone edits the DOM or skips
// this check, every query still runs as their own authenticated role and
// Postgres decides what comes back. This guard exists so an unauthorized
// visitor sees a login/denied screen instead of admin markup and a wall of
// permission-denied errors.
(function () {
  function redirect(url) {
    window.location.replace(url);
  }

  async function requireRole(allowedRoles, opts) {
    opts = opts || {};
    const loginUrl = opts.loginUrl || "/leader/login/";
    const deniedUrl = opts.deniedUrl || "/";
    const allowDuringPasswordChange = !!opts.allowDuringPasswordChange;

    const API = window.RucusoAPI;
    if (!API) { redirect(loginUrl); return null; }

    let session;
    try {
      session = await API.currentSession();
    } catch (e) {
      redirect(loginUrl);
      return null;
    }

    if (!session || !session.profile) { redirect(loginUrl); return null; }
    if (!session.profile.active) {
      await API.adminLogout();
      redirect(loginUrl + "?akaunti=imezimwa");
      return null;
    }
    if (!allowedRoles.includes(session.profile.role)) { redirect(deniedUrl); return null; }
    if (session.profile.must_change_password && !allowDuringPasswordChange) {
      redirect("/change-password/");
      return null;
    }
    return session;
  }

  // super_admin implicitly has every permission; admin needs the explicit
  // flag; leader permissions are handled separately (position + ministry
  // scoping), never through this jsonb map.
  function hasPermission(profile, key) {
    if (!profile) return false;
    if (profile.role === "super_admin") return true;
    if (profile.role === "admin") return !!(profile.permissions && profile.permissions[key] === true);
    return false;
  }

  function isExecutiveLeader(profile) {
    return !!profile && profile.role === "leader" &&
      ["president", "secretary_general"].includes(profile.position);
  }

  async function logout(redirectUrl) {
    if (window.RucusoAPI) await window.RucusoAPI.adminLogout();
    redirect(redirectUrl || "/");
  }

  window.RucusoGuard = { requireRole, hasPermission, isExecutiveLeader, logout };
})();
