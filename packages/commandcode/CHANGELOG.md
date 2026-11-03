# Changelog

## 0.1.22

- Reflection's Beam (`reflection/beam:free`) is sent each earlier assistant
  message's reasoning in `reasoning_content`: its own when the history kept
  it, the thinking sent back as `reasoning`, else a period. Beam answered a
  one-turn chat and turned the second turn away with 400 "Missing required
  parameter: 'messages[N].reasoning_content'", a reply another model made
  included (EDwinpzy on magpie's Discord). Another model the Provider API
  turns away the same way is asked once more with it filled, and is sent it
  from then on. Other models' requests go as they came.

## 0.1.20

- The Credits window of a Go, GOAT or Pro account says credits, not
  dollars: "0.20 / 70.00 credits". Command Code counts those plans in
  usage-value units ("on Go, GOAT and Pro, credits are usage-value units",
  docs/resources/usage-limits, read 2026-10-31). GOAT's 70 credits a month
  are the "up to $100" its pricing page now says on a $100 model like Ling
  3.1 Flash, and $70 on GLM-5.2; Pro's 80 are "up to $110". The 5-hour and
  weekly caps billing/credits returns (GOAT's 14 and 35) are in the same
  units, so the month stays 70 and 80, as the official CLI's table has it,
  and the card no longer calls it a dollar pool (plugins #556).
- On those plans, bought and free credits (dollars at model cost) are said
  beside the month ("+ $5.00 extra") and no longer added to a pool of
  another unit. Max, Ultra and Teams Pro, where a credit is a dollar, keep
  the CLI's pool in dollars.
- Provider is pay as you go: its $15 a month carries no credits, so its card
  shows the balance and no longer a "$x / $15.00" month.
