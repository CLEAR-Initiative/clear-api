# Manual Testing Checklist: Portal Shell + Docs Nav

## Test Environment
- Local dev server: `bun dev`
- Test URLs:
  - `/portal` - Developer Portal (Getting Started tab)
  - `/portal#api-keys` - API Keys tab
  - `/portal/admin` - Admin portal (admin role required)
  - `/docs` - API Documentation

## Desktop Tests (>1100px viewport)

### Portal Shell Navigation
- [ ] **Menu section** contains:
  - Getting Started (active on /portal)
  - API Keys
  - Team (if admin)
- [ ] **Resources section** contains:
  - API Docs
  - Sandbox (opens in new tab)
- [ ] Sandbox link has target="_blank" and opens GraphQL playground
- [ ] Clicking sidebar collapse button persists state to localStorage
- [ ] Sidebar collapse state restores on page reload

### Docs Layout (Anonymous)
- [ ] Left: Portal Shell sidebar with Menu + Resources
- [ ] Center: Docs content scrollable
- [ ] Right: On This Page (~260px width)
- [ ] No old top nav (Home/Sandbox/Portal)
- [ ] No old docs-only left sidebar
- [ ] No Account footer in sidebar (anonymous)

### Docs Layout (Authenticated)
- [ ] Portal Shell includes Account footer with email and role
- [ ] "Sign Out" button visible
- [ ] Click "Sign Out" → no confirmation prompt, immediate sign-out to /
- [ ] After sign-in, docs reload with Account footer visible

### On This Page (Desktop)
- [ ] TOC shows all sections: Build Your First Integration, Introduction, Features, Quick Start, Authentication, Queries, Mutations, Types
- [ ] "Build Your First Integration" section expands to show subsections (The mental model, Get set up, etc.)
- [ ] "Types" section expands to show all GraphQL types
- [ ] Only active section is expanded (others collapsed)
- [ ] Active heading highlighted in orange (#ff6b18)
- [ ] Scroll page → active section auto-expands, inactive collapses
- [ ] Click TOC link → smooth scroll to target
- [ ] Scroll position updates URL hash
- [ ] TOC position fixed, doesn't overlap content

## Mobile Tests (<1100px viewport)

### Mobile Nav Drawer
- [ ] Hamburger menu button visible in top-left
- [ ] Click hamburger → Portal Shell slides in from left as overlay
- [ ] Dark overlay visible behind drawer
- [ ] Click overlay → drawer closes
- [ ] Drawer contains Menu, Resources, Account (if signed in)
- [ ] Click any nav link → drawer closes, navigates

### Mobile On This Page Sheet
- [ ] Floating "On This Page" button visible bottom-right
- [ ] Click button → TOC slides in from right as sheet
- [ ] Dark overlay visible behind sheet
- [ ] Click overlay → sheet closes
- [ ] Click any TOC link → sheet closes, smooth scrolls
- [ ] TOC structure same as desktop (expandable sections)

### Mobile Account
- [ ] If signed in: Account footer visible in mobile drawer
- [ ] Click "Sign Out" → no confirmation, drawer closes, signs out

## Cross-Surface Navigation
- [ ] From `/docs`, click "Getting Started" → navigate to `/portal#getting-started` (no sign-in)
- [ ] From `/docs`, click "API Reference" → navigate to `/portal#reference` (no sign-in)
- [ ] From `/docs`, click "API Keys" / "Authentication" / "Usage Analytics" → `/portal/login?next=…`
- [ ] From `/portal`, click "API Docs" → navigate to `/docs`
- [ ] From `/portal`, click "Sandbox" → new tab to `/graphql`
- [ ] Landing page Sandbox links open `/graphql` in a new tab
- [ ] Admin users: "Admin Panel" link visible, navigates to `/portal/admin`

## Session Behavior
- [ ] Anonymous: no Account footer, docs render with shell
- [ ] Anonymous `/portal` shows Getting Started (default); API Reference works
- [ ] Sign in via `/portal/login` → redirect to `next` (or `/portal`)
- [ ] Docs now show Account footer with email
- [ ] Sign out from docs → reload shows anonymous shell
- [ ] Better Auth cookies set correctly (check devtools)

## Accessibility
- [ ] Keyboard: Tab through sidebar links
- [ ] Keyboard: Tab through TOC links
- [ ] Screen reader: aria-labels on mobile controls
- [ ] Mobile drawer: focus trap when open
- [ ] TOC sheet: focus trap when open

## Performance
- [ ] Docs page loads <2s (body pre-built, shell composed per request)
- [ ] Scroll spy updates smoothly (no janky reflows)
- [ ] Smooth scroll animation fluid
- [ ] Sidebar collapse animation smooth

## Known Deferred Features
- Types scroller with fade mask (stretch goal, not implemented)
