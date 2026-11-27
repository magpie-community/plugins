# 生图调用教程

插件会注册全部可用的对话模型，以及一个统一的生图模型：

- 对话：`model-text`、`deepseek-v41-flash`、`glm-53-flash`、`kimi-k3` 等
- 生图：只显示一个统一模型 `dumate-image2.2`

对外只显示 `dumate-image2.2` 一个生图模型；后台仍会从 DuMate 当前模型清单与内置版本表中选出版本号最高的模型。当前是 `dumate-image2.2`；后台上线更高版本后会自动切换。

## 1. 设置网关地址和 Key

```powershell
$env:MAGPIE_KEY='sk-你的MagpieKey'
$base='http://123.60.6.205:8890/v1'
```

## 2. 查看模型

```powershell
curl.exe "$base/models" -H "Authorization: Bearer $env:MAGPIE_KEY"
```

## 3. 文生图

```powershell
curl.exe -X POST "$base/images/generations" `
  -H "Authorization: Bearer $env:MAGPIE_KEY" `
  -H 'Content-Type: application/json' `
  --data '{"model":"dumate-image2.2","prompt":"白发精灵少女站在森林水流中，阳光穿过树叶，动漫插画","n":1,"size":"1024x1024","response_format":"url"}'
```

也可以直接用具体模型名：

```powershell
--data '{"model":"dumate-image2.2","prompt":"一只白色狐狸，扁平插画","response_format":"b64_json"}'
```

## 4. 使用参考图生成

参考图走 `images/edits`。插件不会调用上游不支持的 `/apis/v1/images/edits`，也不会把超长 data URL 直接发给生图接口；它先用视觉模型读取参考图，再把主体、构图、服装、环境、光线和画风转成提示词，最后调用当前最强生图模型。

```powershell
$ref='C:\path\to\reference.jpg'
curl.exe -X POST "$base/images/edits" `
  -H "Authorization: Bearer $env:MAGPIE_KEY" `
  -F 'model=dumate-image2.2' `
  -F 'prompt=保留参考图的白发精灵少女、白色连衣裙、森林水流与阳光光束，生成一张新的动漫插画' `
  -F 'n=1' `
  -F 'size=1024x1024' `
  -F 'response_format=url' `
  -F "image=@$ref"
```

返回示例：

```json
{
  "created": 1795682774,
  "data": [{ "url": "https://.../image.png" }],
  "model": "dumate-image2.2"
}
```

## 5. 通过 chat 接口生图

生图模型也注册为 OpenAI-compatible image modality，可以通过 chat endpoint 调用，返回 Markdown 图片消息：

```powershell
curl.exe -X POST "$base/chat/completions" `
  -H "Authorization: Bearer $env:MAGPIE_KEY" `
  -H 'Content-Type: application/json' `
  --data '{"model":"dumate-image2.2","messages":[{"role":"user","content":"画一只戴墨镜的猫"}]}'
```

## 6. 常见错误

- `403 key only allows group/image`：网关 Key 被限制到路由组；把该 Key 放行 `dumate/dumate-image2.2`，或把路由组指向这个模型。
- `401 Incorrect API Key`：刷新 DuMate 账号登录态，或在 Magpie 中重新登录该账号。
- `Url is too long`：不要用旧链路直接传 data URL；当前版本已自动转为视觉描述。
- `invalid_model`：插件已自动归一到最强模型；如果仍出现，说明该 DuMate 账号未开通生图工具权限。
