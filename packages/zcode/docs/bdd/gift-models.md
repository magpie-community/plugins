# ZCode limited-quota model entries

## Goal

Keep the plan's normal model list and existing request behavior. Append distinct
`<original-model>-Trial` entries from live ZCode balance data, including models
absent from the normal plan catalog, named in the catalog's spelling. A trial
entry spends the gift; a plain model always spends the coding plan — the choice
is the user's. Display names and IDs use English. All production changes remain
in the ZCode plugin.

## Verification layers

Use the plugin repository's existing Bun tests for model discovery, quota
metadata and HTTP routing. Check the emitted metadata against the current
Magpie plugin contract. No new UI page or test framework is introduced.

## Scenarios

### Show a team member's personal gift plans (#359)

- Given a team seat's ZCode session also holds personal gift plans.
- When the plugin lists models and reads usage, even before resolving the team's key.
- Then the trial entries and personal gift buckets appear beside the team plan.
- And plain models spend the team plan while trial entries spend the personal gift.
- And a missing or expired ZCode session explains why trial entries are absent.
- And a failed gift read leaves the team's allowance available and retries within a minute.

### Add a real limited-quota model

- Given a coding-plan account has an active grant for a model absent from its plan catalog.
- When the plugin discovers its models.
- Then it includes that model as `<original-model>-Trial` alongside unchanged plan entries.

### Keep grant models discoverable while their quota is exhausted

- Given an active grant has an exhausted bucket.
- When the plugin discovers its models.
- Then its gift entry remains discoverable with the exhausted gift quota applied to that entry.

### Ignore ended grants and unrelated capabilities

- Given a balance includes expired grants or non-model capabilities.
- When the plugin discovers its models.
- Then neither creates gift model entries.

### Restore the upstream model name

- Given a request selects a discovered gift model.
- When the plugin sends the request to the grant endpoint.
- Then the request contains the original model name, without the Trial suffix.

### Keep a gift request within the gift pool

- Given the gift endpoint refuses a request and the coding plan still has credit.
- When the selected model is a gift entry.
- Then the plugin returns the refusal without sending a paid-plan request.

### Reject unavailable gift quota without spending paid credit

- Given the selected gift model is exhausted, unavailable, or temporarily blocked.
- When a request selects that gift entry.
- Then the plugin returns a clear error without sending a paid-plan request.

### Scope quota to the selected pool

- Given the coding-plan week is exhausted and a gift remains available.
- When Magpie evaluates the gift entry's quota metadata.
- Then only the corresponding gift allowance applies to that entry.

### Allow a live sibling bucket

- Given one gift bucket is exhausted and another live bucket serves the same model.
- When the plugin maps gift model quotas.
- Then the exhausted sibling does not make that gift entry appear exhausted.

### Allow a live sibling bucket on a gift-only account

- Given an account with no coding plan and two live gift plans (ZCode Trust Build and ZCode Start Plan) whose buckets both serve GLM-5.3-Flash.
- And the Start Plan's bucket is spent while Trust Build's has quota.
- When the plugin reports the account's usage.
- Then GLM-5.3-Flash and its trial entry count on Trust Build's bucket alone.
- And the spent Start Plan bucket stays on the card, set aside, so it doesn't mark the model or the account as used up.

### Keep plain models on the coding plan

- Given a caller uses an existing model ID without the Trial suffix.
- When the plugin routes the request.
- Then the request spends the coding plan, whatever the gift holds.
