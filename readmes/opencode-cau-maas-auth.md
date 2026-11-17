# CAU MaaS — Magpie 插件

将 [maas.cau.edu.cn](https://maas.cau.edu.cn) (中国农业大学 MaaS 平台) 接入 Magpie,支持统一身份认证登录与用量显示。

## 安装

```bash
magpie plugin add github:YuZiOuO/cau-maas
magpie plugin login cau-maas
magpie quota
```

本地开发:`magpie plugin add /path/to/cau-maas`(Windows 可用 `\\wsl.localhost\Ubuntu\...` UNC 路径直挂 WSL 目录)。

## 登录方式

1. **统一身份认证登录(推荐)**:输入学号/工号和 CAS 密码,零浏览器零粘贴。插件纯 HTTP 跑完 SSO 链(OIDC → CAS → ticket 回跳)拿 `jwt_token`,自动复用默认 API Key(没有则以 `magpie` 为名创建)。
2. **直接粘贴 API Key**:已有 Key 时直接使用。

## 实现要点

- `src/index.ts` — 插件主体:`config` 注册 provider、`auth.methods` 两种登录、`loader` 注入 Bearer、`usage` 读 `/api/budget/me`、`provider.models` 列模型
- `src/sso.ts` — CAS 纯 HTTP 登录:`/api/auth/cau/start` → OIDC → `onecas.cau.edu.cn` CAS 表单(`strEnc(学号+密码+lt)` 三重 DES)→ ticket 回跳 → `Set-Cookie: jwt_token`
- `src/des-loader.ts` — 平台原版 `des.js`(Guapo DES 变体)内含隐式全局循环变量,ESM 严格模式会炸,故用 `node:vm` 沙箱加载

平台对 Magpie 暴露的接口全部可用 Bearer API Key 访问:

| 接口 | 用途 |
|---|---|
| `GET /v1/models` | 模型列表 |
| `POST /v1/chat/completions` | 聊天(OpenAI 兼容) |
| `GET /api/budget/me` | 本月用量 / 预算 |
| `GET /api/user/current` | 用户信息 |
| `POST /api/auth/login` `{api_key}` | Key 换会话 cookie(验证 Key) |

## 开发

```bash
bun install
bunx tsc --noEmit
```

入口 `src/index.ts`,Magpie 由 Bun 直跑 TS,无需构建。修改后重新 `magpie plugin add .` 生效。
