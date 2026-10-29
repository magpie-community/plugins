' 静默启动 magpie 对话服务（不弹命令行窗口）
' 双击即可；把它放进「启动」文件夹就能开机自启
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "node serve.mjs", 0, False
