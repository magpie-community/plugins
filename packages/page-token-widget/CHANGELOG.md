# Changelog

## 0.4.12 · 2026-11-16

The small widget fits its frame again, and the note of the large widget says
two things instead of one.

> 小组件最下面那一行「今日 xxx token」被切掉了——不是数字没取到，是那一行根本没画进框子里。
> 那一列原来有 139.2pt 高，而系统给小组件的框子是中组件的高度，最小的手机上只剩 113pt；
> 脚本认得的十二种手机里有八种放不下，被挤出去的恰恰是最后一行「今日」。现在表头那一行不画了
> （读数时间挪到最后一行右端），列高降到 106.8pt，每一台都放得下。小组件也改按自己正方形的
> 宽度排版了，名字不再被系统压小，进度条不再是写死的 120pt。大组件左下角拆成了两段：
> 「Token 含缓存」在左，「剩余 · 5h」在右，两个词再也拼不成一句。

### Fixed

- **The small widget's line about today's tokens was cut off** — the number was
  there all along, the line did not fit into the frame. The column of the small
  family was 139.2pt tall, but its frame (the height of the medium widget)
  leaves 113pt on the smallest phone after the air around it; eight of the
  twelve phones the script knows could not fit it, and the line that fell out
  was exactly the 「今日」 line. The "usage." title row is gone (it cost 26.4pt,
  a quarter of the smallest frame), the time of the reading moved to the right
  end of the last line, and the spacers tightened: the column is 106.8pt now
  and fits every one of the six measured phones with 7 to 35 points to spare.
- **The small widget lays out with its own square width.** It used to measure
  with the width of the medium widget, believing it had twice the room it has:
  the name of the card was squeezed by the system instead of being sized by the
  script, and the bar was a hardcoded 120pt — the smallest card gives 109pt of
  usable width, so the bar was wider than the room it had. Both were named as
  unfixed in the notes of the standalone (0.4.10); the notes of this package
  did not repeat them.
- **The note of the large widget is split in two.** The line used to read
  「剩余 · 5h · Token 含缓存」 under 「今日 xxx K」, and the two read as one
  sentence: five hours of tokens left, cache included. 「剩余 · 5h」 says which
  way the quotas of the cards run, 「Token 含缓存」 says what the two numbers
  above it count. Now the note stands at the left of the last line, directly
  under the numbers it is about, and the word about the cards stands at the
  right end of the same line. The two can no longer be read as one phrase.
- Three new tests guard all three: the column of the small widget has to fit
  every phone with room to spare, its last line holds today's tokens and the
  time of the reading, and the note and the word about the cards are two
  texts with a flexible space between them.
- The medium widget did not change. The six-card layout of the medium family
  still does not fit on the small screens; this release gave way to the two
  problems that were reported, the next one fixes that.
- On the computer this release changed the script of the widget only, so the
  service does not have to be restarted. The script on the phone has to be
  updated once: run the installer (`SetupUsageWidget.js`) in Scriptable again.

## 0.4.11 · 2026-11-15

The word in front of the number is one character, and GLM's quota stopped
freezing.

> 数字前面那个字变成一个字：「剩」或者「用」。两个字占掉的宽度是数字的损失——最窄的手机上格子
> 只有 57.5pt，两个字就要 18pt；现在让出来的地方给了数字：13pt → 17pt，16pt → 20pt。
> GLM 的额度不刷新了——不是网关的问题，是插件自己把它冻住了：网关给 zhipu 的是两行，
> `plan`（有窗口）和 `balance`（账户上的余额，没有窗口）；而「这一组读得好不好」要求每一行都有
> 窗口，于是刚读到的那一组被判成坏的，代码退回去用存下来的那一轮。现在按「有窗口的行」来取读数。

### Fixed

- **The word in front of the number is one character:** 「剩」 or 「用」. The
  cards of the medium widget are narrow, and every point the word takes is a
  point the number does not get (the cell of the smallest phone is 57.5pt
  wide, and two words of 9pt would take 18 of them). The room the word gives
  up goes to the number: 13pt → 17pt on the smallest phone, 16pt → 20pt on the
  SE, 17pt → 20pt on the 12 mini, a little more on the wider phones. The
  number of the large and the small widget was 34pt already and stays.
- **The cards grew a little, because the row of the number grew.** The number
  of the four-card layout is sized after the width of the cell, so it grew
  with the word: the card grew 3 to 5 points (72.2 → 77.2 on the smallest
  phone, where the body has 84; 84.6 → 88.6 on the 12 mini, where the body
  has 94). The one-card layout did not change. Two tests keep it that way:
  the four cards have to fit on every phone with five points of room, and the
  size of the number is pinned.
- **GLM's quota stopped freezing — the gateway was not the cause, the plugin
  froze it.** The gateway sends zhipu two rows: `plan` (the subscription, with
  windows) and `balance` (the money on the account, with no windows). The
  plugin groups the rows by provider and account, so both of them ended up in
  one group; and the question "was this group read well?" asks that **every**
  row has windows. The balance row has none, so the group that had just been
  read was judged broken, and the code went back to the stored round — which
  was the card of the previous round, and that card was written back in turn.
  The numbers of GLM stood still, and the card kept saying that it was old. A
  row without windows is not a reading, it is the balance of an account: it is
  ignored now, and GLM follows the live reading.
- Still open: the six-card layout of the medium widget (two rows of three)
  does not fit on the small phones — 88pt in a body of 84 on the smallest one,
  96 in 94 on the 12 mini. It was like that before this release and is the
  next thing to fix.
- On the computer the GLM fix is in the **service**, so Magpie has to be
  restarted (or the plugin updated) for it to take effect. The script of the
  widget on the phone has to be updated once: run the installer
  (`SetupUsageWidget.js`) in Scriptable again.

## 0.4.10 · 2026-11-15

The content of a card really stands at the left of it now, and the bar is drawn
with the colours of the widget.

> 卡片里的内容都站在最左边了。名字、账号、还有「剩余 + 数字」这一对，以前都浮在格子的中间——
> 固定宽度的一行会把内容放在中间，现在每一行的末尾留一个可伸缩的空位，内容就按在边上。
> **0.4.9 的说明里写的是「这一对回到卡片的最左边」，但发出去的脚本里并没有做到**：这一版才是
> 真的站在左边。进度条用组件自己的颜色画了：组件里问不出系统是不是夜里的外观，颜色在脚本里就
> 定死了；现在七个颜色都是动态的，进度条也不再用画布，它是两层堆叠。

### Fixed

- **The rows of a card stand at the left of it.** The names, the accounts and
  the pair of the word and the number floated in the middle of their cell: a
  row with a width of its own puts what it holds in the middle of itself.
  Every row ends with a flexible space now, so the content is packed at the
  edge. **The notes of 0.4.9 said the pair was back at the left of the card,
  but the script that went out had not done it** — that release deleted the
  code that did it; this one does it for real.
- **The bar is drawn with the colours of the widget.**
  `Device.isUsingDarkAppearance()` is not supported inside a widget, so the
  colours that were picked in the script were baked in with it; the bar was
  drawn on a canvas, which baked them in as well — a bar of the day colours on
  a card of the night reads backwards. All seven colours are dynamic now, and
  the bar is no longer a canvas: it is two layers, and the colours are decided
  when it is drawn.
- **The ink of the bar stands at the left of it.** The ink is the quota that
  is left, the ground behind it is what is used up, and the ground starts at
  the left of the card. The ink is the same ink in both appearances — a
  bright ink in the night reads as a warning, and a warning that means "there
  is plenty left" turns the reading of the whole card around.
- The two rows of the small widget stand at the left as well.
- The script of the widget on the phone has to be updated once: run the
  installer (`SetupUsageWidget.js`) in Scriptable again.

## 0.4.9 · 2026-11-15

Every row of the widget says where it stands, the word and the number share
one centre line, and the number follows the room that is left in the cell.

> 组件里的每一行现在都说清楚自己的内容站在哪里：名字、账号这些行站在自己的上边，「剩余」和数字
> 那一行站在中间。「剩余」两个字和数字站在同一条水平中线上，这一对也回到卡片的最左边（0.4.10
> 发现发出去的脚本其实没做到）。三个组件写同一个词：中号组件的窄卡片原来写「剩」，现在一律写
> 「剩余」或者「已用」。中号四张卡的时候格子只有 69pt 宽，数字的大小改成按格子剩下的宽度来定。

### Fixed

- **Every row states its own placement.** The names and the accounts stand at
  the top of their row, the 「剩余」 and the number share the middle of it.
  0.4.6 only took the centring away and relied on the default alignment of
  Scriptable (the notes said "top"); now every row says it itself.
- **The word and the number share one horizontal centre line, and the pair
  stands at the left of the card again.** The small widget's number row is
  centred as well.
- **All three sizes write the same word.** The narrow cards of the medium
  widget wrote the single character 「剩」 while the small and the large one
  wrote 「剩余」, so the same number looked like two different things; now
  every one of them writes 「剩余」 or 「已用」.
- **The number of the medium widget follows the room of the cell.** With four
  cards a cell is 69pt wide and the word took 18pt of it, so the widest
  number ("100%") did not fit: the size of the number follows the width that
  is left (23pt → 18pt on a 393pt phone, less on the narrower ones). The
  number is written in bold, which is a little wider than the table used for
  the estimate, so two points are kept as air.

## 0.4.8 · 2026-11-15

The number in a card stands in the middle of it, and Codex's image-generation
quota has a name of its own.

> 卡片里的数字站在中间了。「剩余」两个字还是留在数字左边，但「剩余 + 数字」这一组在卡片里水平
> 居中——数字的字体大，这一组挂在卡片最左边看着松。中号、大号组件都改了。Codex 的图片生成额度
> 也有了自己的名字：以前被换成了兜底名字「Quota」，看不出是什么，现在写「图片生成剩余」。

### Fixed

- **The number stands in the middle of its card.** The word 「剩余」 stays at
  the left of the number, but the pair is centred horizontally now — the number
  is written in a large font, and the pair looked loose at the left edge of
  the cell. The medium and the large widget; the small one keeps its column
  (its bar was a hardcoded 120pt, and a centred number would have gone out of
  line with it).
- **Codex's image-generation quota has a name of its own.** The gateway calls
  that window "Image generation"; it used to be renamed to the fallback
  "Quota", and the phone page wrote "Quota剩余", which says nothing. It
  writes 「图片生成剩余」 now. A window whose name is not recognised still
  gets "Quota" — the supplier's own words do not reach the phone — and the
  name survives a cached reading that is fed back.

## 0.4.6 · 2026-11-14

The unit of a quota window is written the same way for every provider, and the
name of a card is not centred in its own row any more.

> 额度的单位统一了：网关那边有的窗口叫「5 hours」、有的叫「4 hours」，组件以前一个写「5h」、
> 一个原样写「4 hours」；现在统一写「5h」「4h」「7d」「30d」。组件上的厂商名和数字不再悬在自己
> 那一行的中间——0.4.5 为了让卡片的高度稳当把文字居中了，这一版去掉，名字和数字都站在各自
> 那一行的上边。

### Fixed

- **The unit of a window is the same for every provider.** The gateway names
  one window "5 hours" and another one "4 hours"; the widget wrote "5h" for
  the first and "4 hours" for the second. Every hour-ish label is now
  written "<n>h" and every day-ish label "<n>d" ("30d" for a month). The
  phone page writes the same window as "5 小时剩余" and "4 小时剩余".
- **The name of a card and the number under it are not centred in their row.**
  The 0.4.5 release centred the text of a line to keep the height of every
  card the same, so a name floated in the middle of its own row; the text
  stands at the top of its row now, in line with the other rows of the card.

## 0.4.5 · 2026-11-14

The bars of the cards of the medium widget sit on one line now. Nothing else
changed: the paired phones, the token format, the widget parameter and the
port are the same as in 0.4.4.

> 中号组件里四张卡的额度条现在在同一条线上。没有账号的厂商（MiniMax、GLM）以前那一行写的是
> 一个不换行空格，高度由手机自己来量，于是它们的条比 Codex 那两张卡高了一截。现在每一行都有
> 自己固定的高度，四张卡的条就在同一条线上。

### Fixed

- **A card without an account of its own no longer puts its bar out of line.**
  The empty line of the account used to be a space whose height the phone
  measured by itself, so the MiniMax and GLM bars sat a little higher than the
  two cards of Codex. Every line of a card now has a height of its own.
- The large widget puts two cards in a row; the two bars of a row sit on one
  line as well. A row that mixes a card with an account and a card without one
  had the same fault (the bars were 11 points apart), and the three-row layout
  of the large widget now keeps the line of the name the same height for
  every card too.
- A test keeps it that way: the four cards of a real page are drawn and the
  line of every bar is read — 55, 55, 45, 45 before, one line now.

## 0.4.4 · 2026-11-14

The code of the standalone plugin (`magpie-page-token-widget`, 0.4.4) is now in this
package, with the community's own name, port and data directory kept.

The two versions are the same number from here on: this package follows the
version of the standalone plugin, so that the two never drift apart in the eyes
of a user. Nothing was published under 0.2.0, so the line starts here.

> 这一版把独立插件（`magpie-page-token-widget` 0.4.4）的代码同步进社区包，保留社区自己的
> 名字、端口和数据目录。最要紧的一件：谁能看控制台，由连接真正落在哪个监听器上决定，不再由
> 请求头决定——尾网上的设备即使伪造 `Host: 127.0.0.1:<端口>`，也只能拿到手机那一份页面，
> 拿不到控制台页面里的服务令牌，也碰不到 `/api/v1/console/*`。

### Fixed

- **The console of this computer is out of reach of the tailnet.** Who may ask is
  decided by the socket a request came in on, not by a header a caller can write:
  the console page (the one that carries the service token) and every
  `/api/v1/console/*` route are served only by the listener on `127.0.0.1`, and a
  request that arrives on the tailnet, the LAN or the phone listener gets the
  phone side whatever its `Host`, `Origin` or `X-Forwarded-*` say. A device in the
  tailnet that sends `Host: 127.0.0.1:<port>` gets the phone page, not the
  console. (`test/boundary.test.mjs` says so out loud.)

### Added

- The plugin's own tests (unit, integration and the boundary ones) travel with
  the package: `node scripts/run-tests.mjs`.
- `options.tailnetAddress` — the address the tailnet listener binds to. It
  exists for the tests and for the rare case of a machine with several
  addresses; the permission of a request does not depend on it.
- A changelog of its own, and a README that tells the whole story: the three
  ways to connect (Tailscale, an address of your own, the LAN), the ports, the
  security boundary, the pairing, the device list, the phone page, the widget
  parameter, the troubleshooting and the uninstall.

### Changed

- The service answers under its community name, `@magpie-community/page-token-widget`,
  and the phone page and the widget script recognise that name when the service
  says "no" — a token that no longer works is wiped and the phone is told to
  pair again.
- The port is 3498 (the phone's 3499), the data directory is `page-token-widget`,
  and the summary in the registry is the same text as `magpie.summary` in
  `package.json`.
- The plugin's entry exports the plugin and nothing else: the cleanup of the
  Tailscale forwarding moved to `lib/cleanup.mjs`.

## 0.1.1 · 2026-11-13

### Fixed

- The phone opens its own page (the page of the service on the phone's port),
  not the console.

## 0.1.0 · 2026-11-13

### Added

- The first version: a local service that reads Magpie's local gateway, a
  console page, a phone page and the Scriptable widget that shows the remaining
  quota of Codex, MiniMax and GLM on the iPhone's home screen.
