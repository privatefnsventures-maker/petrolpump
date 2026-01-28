/* global requireAuth, applyRoleVisibility */

document.addEventListener("DOMContentLoaded", async () => {
  // Server-side role verification via check_page_access() function
  // Even if user bypasses client-side checks, RLS policies block unauthorized access
  const auth = await requireAuth({
    allowedRoles: ["admin"],
    onDenied: "dashboard.html",
    pageName: "analysis", // Triggers server-side access verification
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);
});
