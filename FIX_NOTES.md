# Version 2.0.1 Login Fix

Fixed the browser error:

```text
Cannot read properties of null (reading 'reset')
```

## Cause

In an asynchronous submit handler, `event.currentTarget` is only guaranteed while the synchronous event callback is executing. After the login request completed, the handler tried to call `event.currentTarget.reset()`, but `currentTarget` had become `null`.

## Correction

Each form handler now stores the form element before the first `await` and uses that stable reference afterward. The same protection was applied to registration and dynamically rendered forms. The task-dialog backdrop close behavior was also corrected.

## Version 2.1.0 — Optional organization onboarding

- Made organization creation explicitly optional after sign-up.
- Added Create / Join / Do This Later onboarding choices.
- Added backend `workspace_access` state and frontend membership gate.
- Prevented the dashboard/workspace shell from loading without an active organization membership.
- Added account-only deferred onboarding state and locked-module messaging.
- Added regression and API tests for no-organization and membership-unlock flows.

