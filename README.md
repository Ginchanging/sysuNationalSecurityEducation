# 中山大学 LMS 自动学习助手

用于 LMS 视频学习的 Userscript：自动播放、按活动顺序前进、章节小测优先、期末保护、防自循环。

当前脚本文件：`sysu_lms_auto_player.user.js`  
当前脚本版本：`1.3.1`

## 功能概览

- 自动等待播放器加载并开始播放
- 支持 `playbackRate` 倍速
- 支持 `skipCompleted`（已达 100% 的视频可直接跳过）
- 章节内顺序跳转（不是只找下一个视频）
- 小测提交后在 `quiz/review` 页可自动继续
- 期末保护：识别到“期末考试”时默认停止自动进入
- 防自循环：阻断 `3.2 -> 3.2` 这类重复跳转
- 新规则：**仅当“观看进度 = 100%”才会跳到下一活动**

## 匹配页面

- `https://lms.sysu.edu.cn/mod/fsresource/view.php*`
- `https://lms.sysu.edu.cn/mod/quiz/review.php*`

## 安装方式

1. 安装 Tampermonkey 或 Violentmonkey
2. 新建脚本并粘贴 `sysu_lms_auto_player.user.js`
3. 保存后进入 LMS 课程页面


## 编码说明（防乱码）

- 请确保脚本文件编码为 `UTF-8`（建议 `UTF-8 with BOM`）。
- 如果看到 `涓北...` 这类乱码，通常是文件被按错误编码打开后又保存了。
- 处理方式：在编辑器中切换为 `UTF-8` 重新打开，并确认脚本头部 `@name` 显示为“中山大学 LMS 自动学习助手”。

## 使用说明

1. 进入任意课程视频页，等待右下角状态浮窗出现
2. 脚本会自动播放视频，并持续监控页面观看进度（`.num-bfjd span`）
3. 播放过程中每秒检测进度：
   - 若进度 `>= 100`：立即跳转到下一活动（不等 `ended`）
   - 若视频 `ended` 且进度 `< 100`：自动从头重播当前视频
4. 章节末尾会优先进入本章节小测（若课程结构如此）
5. 你手动完成小测并提交后，进入 `quiz/review` 页面会自动继续下一活动（可配置关闭）
6. 若下一活动是期末考试且 `stopBeforeFinalExam=true`，脚本会停下并提示手动开始

## 下一活动解析优先级

1. `#next-activity-link`
2. 左侧课程导航树（同章节）
3. `#jump-to-activity` / `select[name="jump"]`
4. 同章节 quiz 兜底（排除“期末”）

所有来源都会经过“同活动过滤”（优先 `id/cmid`，再比 `pathname`），避免自跳转。

## 配置项

```javascript
const CONFIG = {
  playbackRate: 1,
  videoLoadTimeout: 15000,
  retryDelay: 5000,
  maxRetries: 3,
  nextPageDelay: 1500,
  skipCompleted: true,
  autoContinueFromQuizReview: true,
  stopBeforeFinalExam: true,
  loopGuardWindowMs: 60000,
  loopGuardMaxRepeats: 3,
};
```

## 关键行为（当前版本）

- 跳转条件已改为：**观看进度达到 100%**
- 播放中途一旦达到 100%，会立即进入下一活动（不等待视频播放结束）
- 进度未满时不前进，自动重播当前视频直到满进度
- 卡住检测不会再“无条件跳下一活动”；会优先恢复播放，必要时重播
- 仅在进度满足完成条件时才进入下一活动

## 常见问题

### 1) 视频结束但没有跳转

先看右下角进度是否真的达到 100%。
如果是 99.x，会按设计继续重播直到到 100%。

### 2) 仍然出现循环跳转

打开浏览器控制台检查日志关键词：
- `same-as-current`
- `self-loop-blocked`
- `未找到下一活动`

### 3) 到了小测后不继续

确认你已经提交并进入 `mod/quiz/review.php`，且 `autoContinueFromQuizReview=true`。

## 免责声明

本脚本仅用于减少重复点击操作，请遵守课程平台与课程要求，合理使用。






