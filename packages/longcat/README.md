# LongCat (长猫) — token resource-pack balance

Ported from **CreditDaddy** (`src/longcatClient.js`). Reads LongCat
(`longcat.chat`, Meituan) active token resource packs' remaining/total/expiry
through the session cookie (Meituan SSO) and reports them as Magpie usage
windows.

## Sign in
Add the plugin, then **login** and paste your `longcat.chat` session cookie.

## Notes (verify before publishing)
- LongCat grants are **purchased/gifted** — there is no daily check-in
  endpoint, so `checkin` returns `ineligible`.
- The `api`-type sign-in method stores the cookie in `auth.key`; the
  loader/getInfo read it there. Confirm Magpie's custom-prompt storage
  against the running host.
