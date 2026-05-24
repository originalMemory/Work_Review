# macOS 截图权限排障

这个文档主要面向开发和调试场景，处理 macOS 上截图结果异常的问题。

## 典型现象

- 截图分辨率正常
- 只能看到桌面背景
- 看不到已打开的应用窗口

这通常不是截图逻辑本身出错，而是 macOS 的 `屏幕录制` 权限记录失效或绑定到了错误的进程。

## 常见触发场景

- 之前使用过 `tauri dev`
- 本机安装过旧版本 `Work Review.app`
- 重新打包、覆盖安装或更换过应用路径
- 开发版和安装版混用

在这些情况下，系统设置中可能仍然显示 `Work Review` 已被允许，但当前运行的这份可执行文件并没有真正拿到有效权限。

## 如何判断是哪个进程在截图

如果当前运行的是安装版，进程通常类似：

```text
/Applications/Work Review.app/Contents/MacOS/Work_Review
```

如果当前运行的是开发版，实际截图进程可能来自：

- `Cursor`
- `Terminal`
- `iTerm`
- `target/debug/work-review`

也就是说，开发调试时需要检查的不一定是 `/Applications` 下那份应用。

## 解决办法

先重置 macOS 的屏幕录制权限记录：

```bash
tccutil reset ScreenCapture com.workreview.app
```

然后按顺序操作：

1. 完全退出 `Work Review.app`
2. 如果之前跑过开发版，也一并退出 `Cursor`、`Terminal` 或 `iTerm`
3. 重新打开应用
4. 在系统弹窗中重新允许 `屏幕录制`
5. 再退出并重开一次应用后测试截图

## 开发版额外说明

如果你当前不是运行安装版，而是运行 `tauri dev`，还要检查下面这些程序是否拥有 `屏幕录制` 权限：

- `Cursor`
- `Terminal`
- `iTerm`

因为调试时，真正执行截图的进程可能并不是安装到 `/Applications` 下的那份 `Work Review.app`。

## 当前项目的实现说明

当前 macOS 截图不是走外部命令，而是直接通过 Rust 截图库调用系统截图能力。

因此一旦权限记录异常，最典型的表现就是：

- 截图可以成功保存
- 但图里只有桌面背景
- 前台窗口内容全部缺失
