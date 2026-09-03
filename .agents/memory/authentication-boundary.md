---
name: Authentication boundary
description: The project's web authentication transport and API protection boundary.
---

The web app uses Replit-managed Clerk with cookie-based browser sessions. Protected API routes should validate the Clerk session on the server; browser callers must not add bearer-token handling.

**Why:** This keeps the web flow aligned with Clerk's proxy/session model and avoids leaking or manually managing credentials in the browser.

**How to apply:** Keep public landing and auth routes accessible, protect archive data and actions with server-side Clerk middleware, and add ownership filtering before treating the app as multi-user.