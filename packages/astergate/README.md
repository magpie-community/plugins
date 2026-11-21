# Astra Magpie

An unofficial AsterGate provider for Magpie. Use an AsterGate API key for
live Claude model discovery and Anthropic Messages. Magpie shows each
reported Claude account's 5-hour and weekly allowance and reset time.

## Install

    magpie plugin add @magpie-community/opencode-astergate-auth
    magpie plugin login astergate
    magpie quota astergate

Enter the API key at Magpie's interactive prompt. The models appear under
astergate/ in Magpie. Magpie saves the key in its plugin account store.
Requests with the key go to beta.astergate.cc.

The plugin queries /v1/models and forwards Anthropic Messages to /v1/messages.
For quota, it follows AsterGate's read-only usage-session flow with a JWE
login and an in-memory session cookie. The quota windows describe individual
upstream accounts, so they are displayed without blocking routing.

Original implementation and testing at [stormluke/aster-magpie](https://github.com/stormluke/aster-magpie).
