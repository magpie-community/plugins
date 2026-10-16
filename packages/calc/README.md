# @magpie-community/tools-calc

Exact arithmetic, unit conversion and date math, as tools [magpie](https://usemagpie.ai) offers every agent it connects. Models get arithmetic wrong (`0.1 + 0.2`, big powers, days between two dates across a DST change), so this gives them a calculator. It needs no network, no key and no dependency.

Install it from magpie's **Plugins › Discover**, or with:

```sh
magpie plugin add @magpie-community/tools-calc
magpie plugin            # lists its tools
```

magpie serves the tools on its MCP server, `/mcp/magpie/tools`, to every agent it has connected. Each tool's name starts with the plugin's short name, `calc`: `calc_eval`, `calc_convert` and `calc_date` (magpie v0.1.1260 or later; earlier versions named them `tools-calc_eval` when installed from npm).

## Tools

**`eval`** `{expression, places?}` evaluates an expression exactly, in fractions, with no floating point.

- Operators: `+ - * / % ^` (or `**`), parentheses, and unary minus.
- Numbers: decimals, `1e9`, `0x`/`0b`/`0o` literals, and `1_000`.
- Functions: `abs floor ceil round trunc min max gcd lcm fact`.
- It answers `{exact, decimal}`, plus `rounded: true` when the decimal was cut at `places` (20 by default).

```
0.1+0.2          → {"exact":"3/10","decimal":"0.3"}
2^128/3          → every digit, exact
1/0              → an error: division by zero
```

**`convert`** `{value, from, to, places?}` converts a quantity exactly. `value` can be an expression, such as `3*1024`.

| Kind | Units |
|---|---|
| Data | `bit B kB MB GB TB` (1000s), `KiB MiB GiB TiB` (1024s), `kb Mb Gb` |
| Time | `ns us ms s min h d wk` |
| Length | `nm um mm cm m km in ft yd mi nmi` |
| CSS | `px pt pc` |
| Mass | `mg g kg t oz lb` |
| Angle | `deg turn grad` |
| Temperature | `C F K` |

```
1 GiB → MB       → {"exact":"16777216/15625","decimal":"1073.741824","unit":"MB"}
```

**`date`** `{date?, add?, to?, timeZone?}` does date math on the real calendar.

- `date` is ISO 8601, unix seconds or milliseconds, or `now` (the default). It answers the ISO time, weekday, ISO week, day of year and unix time.
- `add` is a duration, such as `3d 4h`, `-90m`, `1y2mo` or ISO `P1DT2H`. Years, months and days count on the calendar, so Jan 31 + 1mo is the last day of February, and a day across a DST change is still a day.
- `to` is a second date. The answer then also has `between`, the time from `date` (after `add`) to `to`, in days, hours, minutes, seconds and calendar years, months and days.
- `timeZone` is an IANA zone, such as `Asia/Shanghai`. Dates with no offset are read as that zone's wall time, and the answer shows the local time. Without it, they are UTC.

## Test

```sh
bun test packages/calc
```

中文：给 magpie 连接的每个 agent 提供精确计算工具：`eval` 用分数精确计算表达式，`convert` 换算数据、时间、长度、质量、角度和温度单位，`date` 按真实日历做日期加减和间隔（支持时区与夏令时）。不联网，不需要 key。
