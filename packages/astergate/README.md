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
By default requests with the key go to beta.astergate.cc.

## Configuration

Magpie can use a compatible gateway by setting `{"origin":"https://gateway.example.com"}`
in astergate.json in its configuration directory. Use a trusted HTTPS origin.
The same origin receives model, inference and quota requests. Toggle the
plugin off and on after editing the origin.

The provider setting **Model-specific quota windows** is enabled by default.
Disable it to hide model-specific quota rows on the next refresh.

The plugin queries /v1/models and forwards Anthropic Messages to /v1/messages.
For quota, it follows AsterGate's read-only usage-session flow with a JWE
login and a short-lived, in-memory session cookie. The quota windows describe individual
upstream accounts, so they are displayed without blocking routing.

Original implementation and testing at [stormluke/aster-magpie](https://github.com/stormluke/aster-magpie).
