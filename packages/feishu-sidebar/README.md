# Feishu sidebar

Open Magpie Web in the left sidebar of the Feishu desktop client. This page
generates Feishu's `client/web_url/open` AppLink with `mode=appCenter`.

1. Enable **Settings → Network and sharing → Browser access** in Magpie, or
   start `magpie web`.
2. In **Plugins → Feishu sidebar**, enter the Web address, for example
   `http://127.0.0.1:3430` on the same computer. Use a reachable HTTPS
   address for Magpie on another computer. Leave out the `?k=...` sign-in
   parameter from the URL printed by `magpie web`.
3. Generate the link and copy the selected text to your own Feishu chat.
   Open it in Feishu desktop. If Magpie asks for its Web access key, enter
   the key on Magpie's sign-in screen. To keep the tab, right-click it in
   the left sidebar and pin it.

The plugin generates the link locally in a sandboxed page. It doesn't read
Magpie data, store the address, or send a request. The link includes the
destination address, so share it only where you intend to disclose that
address. Magpie Web still handles authentication.
