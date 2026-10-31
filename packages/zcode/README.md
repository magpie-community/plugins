# @magpie-community/opencode-zcode-auth

Signs in to Z.ai's GLM Coding Plan, or BigModel's (智谱). It does this the
way [ZCode](https://zcode.z.ai) does, and serves the plan's GLM models
over Anthropic's Messages API. Provider id: `zcode`.

## Signing in

- **ZCode: Z.ai GLM Coding Plan** and **ZCode: BigModel (智谱) GLM Coding Plan**
  - zcode.z.ai opens a sign-in flow, and the browser signs in to Z.ai or to
    BigModel. The plugin polls the flow until it is done, so there is
    nothing to paste.
  - With that sign-in it takes the key named `zcode-api-key` from the
    account's default project, or makes it if it isn't there, as ZCode does.
    Requests go to `api.z.ai/api/anthropic` or
    `open.bigmodel.cn/api/anthropic`.
  - If the account has no plan of its own, it looks for a seat on a team's
    plan and uses that team project's `zcode-team-api-key`.
  - Failing both, it uses ZCode's free **Start Plan**, served by zcode.z.ai
    with ZCode's session token.
  - zcode.z.ai serves the Start Plan only to requests that look like the
    ZCode client's own, and refuses others with HTTP 405 "request has been
    blocked due to unusual activity". So a Start Plan request goes as
    ZCode's does: ZCode's headers, ZCode's three system blocks with the
    agent's system prompt at the end of the third (a fourth block is
    refused, #343), the day in a `<system-reminder>` turn before the agent's
    turns, and the sign-in's device id in `metadata.user_id`. GLM Coding
    Plan and team requests go as the agent sent them, but for that same
    `metadata.user_id` when the agent sent none: ZCode puts it on every
    request, and the plan's endpoint keeps a prompt cache on the machine it
    picks by it, so without it the cache is mostly missed (#387). An
    account known only by its key gets a device id made from the key, the
    same on every start. Every request also carries the `x-session-id`
    header below. zcode.z.ai also
    answers 405 code 3012 to every request of an account its risk control
    blocked, ZCode's own app's included (plugins#348). That answer comes
    back as ZCode's words, then "ZCode's risk control blocked this account
    for unusual activity (code 3012); …", which magpie reads as the account
    restricted: it rests, and the group's other providers are used. Only
    ZCode support lifts such a block. A block page from ZCode's edge
    firewall says this network's address was blocked instead.
  - The Start Plan's token can't be refreshed. When it runs out, sign in
    again.
  - Every request, on any plan, names its conversation in `x-session-id`,
    as ZCode does: a bare UUID, the same on each turn. BigModel's prompt
    cache follows it: without it a long conversation's turns hit the cache
    about one time in twenty, with it nearly every turn (#387). The
    agent's own session id (magpie tells it to the plugin) goes as it is
    when it is a UUID, else as a UUID made from it, so the vendor sees
    only ZCode's format; with none, a UUID made from the device. The same
    id is `metadata.user_id`'s `session_id`, as in ZCode's requests.
- **ZCode: a team's GLM Coding Plan**
  - For an account with a plan of its own and a seat on a team's plan
    (#285). The sign-ins above take the account's own plan, as ZCode does
    by default; this one asks which site, signs in the same way, and
    takes the team seat's `zcode-team-api-key`, as ZCode does when its
    plan picker is switched to the team's plan.
  - It is kept as an account of its own, named `<email> (team)`, beside
    the account's own plan, so both can be used.
  - With no seat on a team's plan, it says so and signs in to nothing.
  - The same ZCode session also reads the person's gift plans. Their
    `<model>-Trial` entries and gift buckets appear beside the team's
    models and allowance. Plain models spend the team plan; trial entries
    spend the personal gift, with no fallback to the team on refusal.
- **ZCode app's sign-in**
  - Uses the account the ZCode app on this computer is signed in to. For
    every request it reads ZCode's own credentials (`~/.zcode/v2`), so it
    follows ZCode as it signs in again, renews its session or switches to a
    team's plan, but only while ZCode is signed in to that same account.
    Once ZCode signs out, or signs in to another account, the sign-in uses
    what it saved when it was added; when that session has run out, it
    asks to be signed in again. It never sends one account's requests with
    another's credentials: to use both, add the app's sign-in once for each.
- **GLM Coding Plan API key**
  - Paste a key (`<id>.<secret>`) and say which site it is from.
  - A key reaches the GLM Coding Plan alone. ZCode's gift plans (the
    Start Plan, ZCode 1024 Dev Day) are served to ZCode's own session,
    which a key doesn't carry: for an account with only a gift plan, the
    card and each refused request (1113) say to sign in with ZCode
    instead. For an account with a GLM Coding Plan, the card says the
    gift plans' `-Trial` models need ZCode's sign-in, since a key lists
    none of them.

## Where the sign-in is kept

In OpenCode's `auth.json` (magpie: `plugin-auth.json`), under `zcode`:

- **The browser sign-ins** are kept as an `oauth` entry:
  - `access` is the key.
  - `refresh` is JSON holding the site, the endpoint, the key, ZCode's
    token, the team project, the plan and a device id of this plugin's own.
- **A pasted key** is kept as an `api` entry, with the site in `metadata`.

The plugin never writes ZCode's own credential store. It reads it only for
the ZCode app's sign-in (`refresh` then holds `"source": "zcode"`).

## How requests are routed

Before each request, the plugin checks which plan the account is on, and
asks again every 10 minutes, and with every read of the usage card, so a
plan bought, a gift claimed or a plan lapsed reaches the requests when the
card shows it. A key whose plan list once reads no plan after reading one
is asked again after a minute, and a Start Plan refusal on such a key reads
the plans again on the next request:

- If the key's account has a GLM Coding Plan
  (`/api/biz/subscription/list`), its requests go to that plan. A model
  the account's gift plans also serve is listed again as
  `<model>-Trial`; asking that entry spends the gift (see below).
- Otherwise they go to the gift plans.

Every request carries the key as both `x-api-key` and
`Authorization: Bearer`.

**The gift's trial entries.** An account with a GLM Coding Plan can
also hold gift plans from ZCode activities, ones that expire on a fixed
date. Their allowance would lapse unused if every request went to the
coding plan, so the plugin reads the gift's balance (per the sign-in's
session, kept for 10 minutes) and lists every model a live bucket
serves again as `<model>-Trial`, named in the catalog's spelling
(GLM-5.3-Flash-Trial). Asking a trial entry sends the model to the
gift, dressed as ZCode's own; asking the plain model spends the coding
plan — the choice is the user's. A bucket is judged spent only by its
`remaining_units` — a missing one is unknown, not spent. A trial entry
whose bucket is spent or blocked answers 429 without touching the
coding plan; when the gift answers a trial entry with a quota error
(code 1113 "Insufficient balance or no resource package", code 1005
"exceed quota limit", which it can answer inside an HTTP 200) that too
becomes a 429 and keeps the entry off for a minute. Any other gift
answer (its 405, its 401, its 5xx) goes on as it came: the user picked
the gift, so the coding plan is not spent behind their back. Every other
429 counts as spent — Z.ai's 1302/1303 rate limits among them — while the
plan's own in-flight cap (3008/3009) does not: such a request is asked
again instead (see [A few at once](#a-few-at-once)). A stream's body is
never read or buffered on the way.

**Free first.** Picking `-Trial` by hand keeps the choice the user's,
but an agent that always asks the plain model never sees the gift.
`freeFirst` turns the preference around: the plain model spends the
account's own live gift first, and falls back to the coding plan when
the gift cannot serve it — a bucket that is spent, a model the gift
does not serve, no ZCode session, or the minute's rest a refusal just
earned. Turn it on for the whole plugin in magpie's Plugins › Options

```json
{ "freeFirst": true }
```

or on the provider alone, under `provider.zcode.options` in the config
magpie hands its plugins — a key only `plugins.json`'s `config` carries,
so the plugin's own options are the ones magpie's Plugins › Options
edits. Where both say something, the provider's word stands. An account
with a coding plan and a gift spends the gift until it is spent, then
the plan; a gift-only account already goes to the gift by its plain
names, so the option changes nothing there. Across the accounts magpie
rotates, each spends its own gift before its own plan — which is the
point: free allowance is spent before subscribed quota, on every
account, with no per-account naming to keep up.

Two boundaries worth knowing. The gift is judged before the request is
sent, from the balance read the plugin keeps for ten minutes: a gift
that runs out between that read and the send has its refusal answered
from the plan in the same request — any gift failure is, its own
waited-out busy cap included, and the replay waits out the plan's busy
cap as any plan request does — and a spent answer or a block page rests
the model a minute and drops the route's balance read, so the requests
behind it go straight to the plan. A gift that cannot be asked at all —
the network, the host — is answered from the plan the same way, the
route read dropped for the next request, while a caller's own abort
stays an abort. The agent sees the plan's answer
either way. When a refusal is fresh, the usage card says so — **"ZCode's
gift is refusing requests — freeFirst answers from the coding plan until
14:02 (the network's address is blocked)"** — so a gift sitting idle
beside a fat balance is explained, not silent. A block page rests every
model the gift serves for the route's ten minutes (an address block
outlasts a minute), a spent answer rests its one model for a minute, and
any other failure is named with its status; while a rest is on, the
requests behind it go straight to the plan. And the `-Trial` entries
keep their own strict semantics —
asking one is still an explicit pick of the gift alone, never the plan;
a spent one answers 429 with freeFirst on, as it does without it.

## A few at once

A plan serves one account a few requests at a time; past that, ZCode
answers 429 with code 3008 "user concurrency limit exceeded", or 3009
"model concurrency limit exceeded". magpie funnels every agent's and every
session's requests of one computer through this one plugin process, so
magpie's own queue spaces an account's requests by the number this plugin
declares — `maxConcurrency` on the auth hook, and `magpie.maxConcurrency`
in its `package.json`, both three. A request the vendor refuses anyway
waits a moment (a quarter of a second, then longer — about ten seconds of
waits in all) and asks again, the same request byte for byte. A cap that
outlasts the waits goes on as a 429, ZCode's words followed by what they
mean, so the agent reads why. magpie still reads it as a rate limit: the
account rests a minute and the request goes to the next member of its
routing group, as it did before.

Three is a default, not a cap the plugin enforces. A plan's real cap
follows its tier — Z.ai serves a Max plan more at once than a Pro, and a
Lite fewer — and is higher off-peak
([Z.ai's usage policy](https://docs.z.ai/devpack/usage-policy)), so a
number written into the plugin would hold a Max account to a Lite one's
with no way to raise it. A user who knows their plan's cap sets it on the
account or the provider in magpie, and magpie's queue follows that.

## The usage card

An account with both plans shows both allowances: the coding plan's
windows first, then the gift's buckets, each with its own name, models
and end. The card's plan and term stay the coding plan's. A gift read
that fails leaves just the coding card — magpie hides a card's windows
behind an error, so a gift hiccup must not black out a working Coding
Plan. A gift that goes out of date while requests use it simply stops
showing. Beside the coding plan's windows each gift bucket is named by
its model first, as ZCode's own "Today's balance" lists it, then by its
plan ("GLM-5.1-Trial · Start Plan"), one plan or several, so the two
allowances can't be read as one. The model comes first because magpie's
ring and account row cut a long name short: "ZCODE GLOBAL BUI…" (the
Start Plan claimed on 10-29) said neither (#504).

**Gift plans that start later.** A plan on the balance whose `starts_at`
is still to come (a Start Plan taking effect at 23:00 today) serves
nothing yet: no request goes to it and its buckets don't count. The card
names it in a line set aside, "ZCode gift plan not started yet", with
the plan's name and its start in this computer's time as the display
("Start Plan · 2026-10-29 23:00"), soonest first. An account whose only
gift plan starts later gets a card with that line, not "ended or never
started". The status ZCode gives such a plan has not been seen, so any
status but `expired` is taken; `starts_at` decides it.

**Resets.** A GLM Coding Plan of the account's own, and a team seat,
show the resets the vendor's usage page lists
(`/api/biz/customer-package-reset/list`, `targetType=PERSONAL` with the
plan's key, `TEAM` with the team's sign-in): how many of the five hours
and of the week are still available, and when each runs out, soonest
first. A team's are marked a team's. They are only read; a reset is
spent on the vendor's own page. A list that can't be read, or has none
left, shows no count.

**Gift plans ZCode holds but has not granted.** ZCode hands out one-off
trust-build / gift plans (a day's ZCode Trust Build, say) that are not
on the account until the ZCode app claims them. The plugin reads the
app's own lists of them with the card and names them there: its claim
banners' feed (`GET /api/v1/marketing/touch`, each delivery's
`claim_zcode_plan` button) and `GET /api/v1/zcode-plan/billing/preview`.
A banner plan (a weekend's ZCODE WEEKEND BUILD, 10-30) is in the feed
alone, never in the preview (#503) — the window is named "Gift plans to
claim in the ZCode app" and the display shows "1 · ZCode Trust Build"
— set aside, so the line stops nothing and routing, usage caps and the
menu bar pass it over. The name is a fixed sentence magpie can
translate; the count and the plan's own name are the display. Reading
the card never claims one. A preview that fails, or lists nothing, adds
no line at all, and a card that is an error keeps its error. Claim the
plan in the ZCode app (open it once), or let the daily claim below do it;
the next read shows it as an ordinary gift bucket.

## The daily claim

With ZCode turned on in magpie's Settings → Daily check-in (it is off
until you turn it on), magpie has the plugin claim each account's gift
plans once a day (`auth.checkin`; `magpie accounts checkin` asks now). It
reads both lists above (the banners' feed and the preview, each plan
once) and posts each plan to
`POST /api/v1/zcode-plan/billing/claim` (`{"plan_id": …}`) with the
account's ZCode session, as the app does. The answer is judged by the
body's code, not the HTTP status:

- nothing listed: *inactive* (ZCode answers an account with nothing to
  claim `{"code":0,"msg":""}`, with no list at all). A list that doesn't
  read is *failed*, never nothing to claim. A plan just claimed may show
  in neither `billing/preview` nor `billing/current` until its
  `effective_at`, so neither list is read as "claimed or not";
- code 0: *claimed* (the next request uses the plan);
- code 1003 "target already exists" (HTTP 200): *done*, claimed before;
- code 3007 "captcha verify failed": *captcha*, the plan is claimed in
  the ZCode app (on 10-06 ZCode wanted the app's Aliyun captcha for a
  claim; whether it still does for a fresh plan is not known yet);
- anything else, an HTTP error without a code, or a reply that isn't
  JSON: *failed*, which magpie asks again later that day. It is never
  taken as claimed, and a failed claim leaves the account's sign-in
  alone.

An account added with a GLM Coding Plan key has no ZCode session to claim
with (*ineligible*).

**No ZCode session.** A card read with a key, or with a sign-in whose
ZCode session has run out (it can't be renewed), sets aside a line named
"ZCode gift plans (-Trial models) need ZCode's sign-in", with why in its
display: such an account reads no gift and lists no `-Trial` entries.
Sign in again with ZCode to get them back. A gift read that fails
otherwise is asked again a minute later, not ten.

## Models

The models are the ones ZCode offers for the account's plan. They come
from ZCode's provider config: the release zcode.z.ai names, or an
installed ZCode's copy if that one is newer. The list is kept for 10
minutes. When the config can't be read, the plugin falls back to this list
(and magpie keeps the list it was told last, unless the account's gift
plans add `-Trial` entries, which are told as read):

| Model | Context | Output | Efforts |
|---|---|---|---|
| GLM-5.3 | 1M | 128K | low, high, max |
| GLM-5.3-Flash | 1M | 128K | low, high, max |
| GLM-5.2 | 1M | 128K | none, high, max |
| GLM-5-Turbo | 200K | 64K | none, high |

The Start Plan's config has all of these except GLM-5.3. An account
with no GLM Coding Plan also lists every model its gift plans serve under
the model's own name, as ZCode does (the Start Plan's GLM-5.3 bucket makes
GLM-5.3 a model), since all of its requests go to the gift anyway.

A gift plan's models appear again as `<model>-Trial` entries, so a
request can spend the gift's quota on purpose. A trial entry is listed
while any live bucket serves its model, spent buckets included (a spent
entry answers 429 rather than vanishing mid-session).

Two plans can give one model (ZCode Trust Build and the Start Plan both
give GLM-5.3-Flash). The server picks the bucket, so the usage card
counts the model on its live bucket, the least used, and sets a spent
sibling aside. A spent sibling never makes the model, or the account,
look used up while another bucket still has quota.
