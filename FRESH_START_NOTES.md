# Fresh-start iteration

- Removed all bundled demo users and the Acme Workspace dataset.
- Removed automatic demo seeding at server startup.
- Sign in / Create ID is now the only unauthenticated entry screen.
- Added `npm run reset` to rebuild an empty database.
- Retained `npm run seed` as a compatibility alias that also creates an empty database.
- Organization onboarding and workspace membership locking remain enforced.
