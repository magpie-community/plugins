# Changelog

## 0.4.19 · 2026-11-22

The list of vendors leaves the plugin: every subscription Magpie knows is a subscription
the widget shows. Add one in Magpie and it shows up at the next refresh; remove one and
it goes away by itself. The widget itself did not change.

> 订阅的名单从插件里拿走了：Magpie 里有哪家订阅，组件就显示哪家。在 Magpie 里新加一门
> （比如 Qoder），它下一次刷新就出现；删掉一门，它也自己消失。组件本身一个像素都没变。

### Changed

- **A vendor that is not written down in the plugin is a vendor of its own.** It carries
  the name Magpie gives it and its plan is shown as it is. A subscription that is removed
  in Magpie no longer comes back from the reading that was stored.
- **Following Magpie is the default.** The first row of "which subscriptions" in the
  plugin page is "all subscriptions (follow Magpie)"; the order you have given stays, and
  the page says which of the two ways is in use.
- **The tokens of today and the ranking of the vendors know a new vendor too.** The usage
  carries the stable id of the vendor, so the card finds its number, and the ranking on
  the phone says the name of the software instead of "Unknown".
- **Quota windows that carry the same name are numbered.** Three windows called "Quota"
  become "Quota 1", "Quota 2" and "Quota 3".
- **A few edges are fixed as well**: a vendor id may carry a dot or an underscore, a plan
  may be written with capitals and a space, a vendor whose name is a word of the
  prototype is counted like any other, and an address of the user that holds a dollar
  sign does not break the script of the phone.

## 0.4.18 · 2026-11-21

The rules of the release of the standalone plugin are stricter once more: both jobs
of the publishing workflow run on the same Node, the guard asks which workflow is
running, and a pre-release is held by a test. Nothing in this package changed.

> 独立插件发版的规则又严了一点：两个活用同一个 Node，守卫会问「这次运行的是哪个工作
> 流」，预发布那条路也有了测试。这个包里的东西一个都没变；版本号跟着独立插件走。

### Changed

- **Both jobs run on the same Node.** The job that checks the release now runs on
  the Node the package is packed with, and the version of npm is looked at in the
  job that really publishes.
- **The guard asks which workflow is running.** A run that does not say which
  workflow it is does not pass any more: the rule about the workflow of the run
  was skipped silently before, and it is a reason to refuse now.
- **A pre-release is held by a test.** The line that keeps a pre-release out of
  npm was not held by any test, so it could have been deleted without one single
  red test; it is held now.
- **Nothing in the package changed.** The code here is the code of the standalone
  plugin, and that code did not move in 0.4.18. There is nothing to update on the
  computer and nothing to run again on the phone.

## 0.4.17 · 2026-11-21

The rules that decide whether a release may go out are stronger now: the guard
asks the tag which commit it means, and the code of a release never runs in
the job that holds the publishing token. Nothing in this package changed.

> 发版的规则变严了：守卫自己去问标签是哪个提交，而不是问「这次运行的提交」——npm 认的是工作流的
> 名字和仓库，不认分支；发版代码也不再跑在握着发布令牌的那个活里，只有打过包、查过的那一个包会
> 发出去。这个包里的东西一个都没变。

### Changed

- **The guard asks the tag, not the run.** npm trusts a workflow by its name
  and its repository, not by the branch it runs from, so the rules now read
  `refs/tags/<tag>` and ask which commit that tag means, whether that commit
  is on `main`, and whether the version in `package.json` of that commit is
  the version of the tag.
- **The code of a release never touches the publishing token.** The workflow
  has two jobs: the first one reads the code, asks the questions, runs the
  tests and packs the package; the second one takes the packed package and
  publishes it, and runs no code of the repository at all.
- **A pre-release is not published.** The release event of GitHub fires for a
  pre-release as well, and npm makes the version that goes out the version
  everybody gets: a release candidate would become the latest one right
  away. The job that publishes skips a pre-release, and the guard refuses a
  tag that carries a suffix such as `-rc.1`.
- **Nothing in the package changed.** The code here is the code of the
  standalone plugin, and that code did not move in 0.4.17. There is nothing to
  update on the computer and nothing to run again on the phone.

## 0.4.16 · 2026-11-21

The standalone plugin is sent to npm by GitHub Actions itself now, so no token
is used any more. Nothing in this package changed; the number follows the
standalone plugin.

> 独立插件发到 npm 的方式换了：现在由 GitHub Actions 自己的工作流发布（npm 叫它 trusted
> publisher），不用令牌了。这个包里的东西一个都没变；版本号跟着独立插件走。

### Changed

- **The way it is published changed, not the package.** The standalone plugin
  (0.4.16) is published by a workflow of GitHub Actions that holds an OIDC
  token, and npm trusts that workflow as a trusted publisher, so no access
  token is kept anywhere any more. The workflow asks two questions before it
  sends anything: whether the release is on `main`, and whether the tag and the
  version in `package.json` are the same. If one of them does not hold,
  nothing is published.
- **Nothing in the package changed.** The code here is the code of the
  standalone plugin, and that code did not move in 0.4.16. There is nothing to
  update on the computer and nothing to run again on the phone.

## 0.4.15 · 2026-11-21

The widget settings of the plugin page are two blocks of their own now, and
every change says whether it went through.

> 插件页的「小组件」分成两块了：第一块「显示内容」管数字是剩余还是已用，三种尺寸的组件都听它；
> 第二块「小号组件显示哪一张」只管小号组件看哪张卡，中号和大号组件显示的是上面「显示哪些订阅」
> 里勾出来的那些。以前这两组选项挤在同一个列表里，页面上没写哪一组是哪一组，得靠猜；现在各在一块
> 里，各有各的说明。插件页的改动本来就是直接记下的（勾一下、拖一下、名字打出来都直接落盘），页面
> 上却没有一处说这件事；现在每一块下面都有一行小字写着这一下有没有存上（保存中／已经记下／没有存上），
> 存不上的时候那行字后面跟着一个「重试」，点一下再试。名字改成边打边存（停手半秒就写），并且修了两个
> 真会被咬到的问题：改完名字点别处时整张订阅表会被重画，正在输入的另一个名字会被冲掉、光标也跑了；
> 两个名字一起改时，服务端收下的是一整张表，后一个会把前一个顶掉——现在名字是一个一个排队发的。
> 最后一家订阅是勾不掉的：全勾掉组件就没有内容了，这时把最后那个勾放回去。

### Changed

- **The widget settings are two blocks of their own.** The first, "what it
  shows", holds whether the numbers are what is left or what is used, and
  every size of the widget follows it. The second, "which card the small one
  shows", holds the card of the small widget; the medium and the large widget
  show the subscriptions that are ticked under "which subscriptions". The two
  groups of choices used to sit in one list, and the page did not say which
  group was which — you had to guess. Each is in a block of its own now, with
  its own note.
- **Whether a change went through is visible.** The plugin page always saved
  on the spot (a tick, a drag, a name typed in), but nowhere on the page said
  so. Every block now has a line of its own below it: saving / it is written
  down / it did not go through. When it did not go through, a "try again" sits
  next to that line.
- **A name is saved while it is written.** A name used to be written down only
  when the field was left, so nothing seemed to happen while it was typed. It
  is written down half a second after you stop, and at once when the field is
  left.
- **Two real bugs are fixed.**
  - **A name could be lost.** Clicking away after naming a subscription drew
    the whole list of subscriptions again, which wiped the name being typed in
    another row and took the cursor away. The list is left alone now.
  - **Two names could push each other out.** The service takes the names as
    one whole table, so a name that had not landed yet was gone when the next
    one arrived with its own table. The names now travel one after another,
    each one continuing from the result of the one before it.
- **The last subscription cannot be ticked out.** Ticking everything off would
  leave the widget with nothing to show, so the last one is put back, with a
  word about why.
- Three new tests guard all of this: the two choices of the widget are two
  blocks and not one list, a change says whether it went through, and a name is
  saved while it is written and does not push another one out. All three are
  red on 0.4.14.
- On the computer this release changed the plugin page only, so the plugin has
  to be updated and reloaded. The script on the phone did not change, so
  there is no need to run the installer (`SetupUsageWidget.js`) again.

## 0.4.14 · 2026-11-21

The cards carry the names the software gives the vendors, a subscription can be
given a name of its own, and the countdowns are written at one size.

> 卡片上的厂商名换成软件自己给的那个名字：Magpie 给 zhipu 的是「Zhipu GLM」，给 minimax-cn 的是
> 「MiniMax (China)」，组件以前写死自己的「GLM」「MiniMax」，软件里看到的余额和组件上的卡片说的是
> 两家不同的东西。插件页「显示哪些订阅」里每一行下面多了一个输入框，可以给订阅另起一个名字，留空
> 就用软件里的名字；名字记在这个账号上，手机页面和组件都用它。倒计时的字号统一了：同一段字以前有
> 三个字号（大组件共用窗口时 10pt、不共用时 8 或 9pt，中组件挤排时窗口名写死 8pt），现在同一族里
> 只有一个字号。厂商之间从来没有单独的字号——MiniMax 的「5 小时」看着比别人大，是因为它只有
> 5 小时一个窗口，没有周额度那一行。名字换长了，标题的字号跟着小一点：四张卡的中号组件在常见的手机上
> （390×844）标题是 9.7pt（以前是 12pt），嫌小就给这一家另起一个短名字。小号组件的参数认软件里的
> 名字了：`zhipu`、`minimax-cn` 现在和 `glm`、`minimax` 一样能找到那张卡。

### Changed

- **A card carries the name Magpie gives the vendor.** Magpie calls zhipu
  "Zhipu GLM" and minimax-cn "MiniMax (China)"; the widget used to carry names
  of its own ("GLM", "MiniMax"), so the balance in the software and the card on
  the home screen talked about two different things. The widget now takes the
  name the gateway sends, and a name that cannot be shown (one that carries the
  separator of a label, one that is too long, one with control characters in
  it) falls back to the plain name of the family.
- **A subscription can be given a name of its own.** Every row under "which
  subscriptions" on the plugin page has a field of its own now; leave it empty
  and the name of the software is used. The name belongs to that account, and
  the page on the phone and the widget both carry it.
- **The countdown is written at one size.** The same words used to be written
  at three sizes: the large widget wrote them at 10pt when the page shared one
  window and at 8 or 9pt when it did not, and the name of the window (`5h`) in
  the dense medium layout was pinned at 8pt, a point smaller than everything
  else on that card. Within one family the same words now have one size.
- **The names are longer, so the titles are a little smaller.** "MiniMax
  (China)" is longer than "MiniMax". With four cards the medium widget writes
  its titles at 9.7pt on a common phone (390×844), where it wrote 12pt before;
  with three cards the cells are wider and the titles stay at 12pt, and on the
  smallest phone four cards are written at 8.1pt. If that is too small, give
  that one subscription a shorter name of your own.
- **The parameter of the small widget knows the names of the software.**
  `zhipu` and `minimax-cn` now find the same card as `glm` and `minimax`.
- Ten new tests guard all of it: the name of the vendor is used, a name that
  cannot be shown falls back to the plain one, the name survives a reading that
  was stored, the name the user gives is used and the ones that cannot be are
  dropped, the countdown of the large widget is one size whether the page
  shares a window or not, the name of the window is one size in both layouts of
  the medium family, the small widget knows the names of the software, and the
  row that is dragged carries the name with it. All ten are red on 0.4.13.
- On the computer this release changed the service and the script of the
  widget, so the plugin has to be updated and reloaded. The script on the phone
  has to be updated once: run the installer (`SetupUsageWidget.js`) in
  Scriptable again.

## 0.4.13 · 2026-11-20

The vendor list of the legacy gateway counts every request again, a new
account never shows the usage of the old one, and the medium widget fits five
and six cards on a small screen.

> 旧版网关的今日厂商用量按网关返回的厂商合计显示。即使个别账号读取失败，厂商榜仍能显示完整用量。
> 同一天更换账号邮箱或遇到同名账号时，组件会清除该账号的旧用量，等待读到对应账号的新数据。
> 停用或立即重启插件时，服务会等待正在进行的 Tailscale 转发操作结束，再清理自己创建的转发和监听器。
> 桌面端选中整个厂商后，可以将该厂商的任一可见账号设为小号组件的默认卡片。中号组件同时显示 5 或 6 张
> 卡片时，账号简称和厂商同排显示，小屏也能放下第二排进度条。

### Fixed

- **The vendor list of the legacy gateway counts every request.** The gateway
  reported 100 Codex requests, but when one account failed to load, the list
  showed only the other account's 40. The list takes the total the gateway
  itself reports per vendor now, and the numbers of the accounts are counted
  apart from it.
- **A new account never shows the usage of the old one.** When an account email
  changes on the same day, or two accounts carry the same name, the stale
  reading of the old account is dropped instead of being shown under the new
  card; the card waits for the reading of the account that is really there.
- **Stopping and restarting do not race the cleanup any more.** With the plugin
  disabled, a Tailscale forwarding that was still running could finish after
  the cleanup had gone by. The shutdown stops taking new forwarding work, waits
  for the work that started, and only then takes away the forwards and the
  listeners that belong to this instance.
- **The account picker of the small widget follows the same rules as the
  service.** Selecting a whole vendor in the plugin window offers the visible
  accounts of that vendor, and selecting one account offers only that account.
- **The medium widget fits five and six cards.** The name of the account and
  the vendor stand on one line now, so two cards of the same vendor can be
  told apart, and the spacing of the rows and the size of the text follow the
  height the medium widget really has: on the six measured screens the second
  row is whole, the bars of a row stand on one line, and the name of the
  account can be read.
- Eleven new tests guard all of it: the vendor total survives an account that
  fails to load, a changed account clears the old reading, a stop waits for
  the forwarding that is running, the picker offers the accounts of the
  selection, and the five and the six cards of the medium widget fit every
  phone with their bars on one line.
- On the computer this release changed the service and the script of the
  widget, so the plugin has to be updated and reloaded. The script on the phone
  has to be updated once: run the installer (`SetupUsageWidget.js`) in
  Scriptable again.

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
