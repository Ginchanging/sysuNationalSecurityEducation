# 中山大学 LMS 视频自动播放器

一个用于中山大学 LMS 的 Userscript 脚本。  
当前版本会自动播放视频，并按课程活动顺序自动跳转，同时内置“期末保护”和“防自循环”机制。

---

## 功能概览

- 自动等待播放器加载并开始播放
- 自动设置播放倍速（默认 `1x`）
- 可选跳过已完成（100%）视频
- 视频结束后自动跳转到下一活动（不仅是视频）
- 在 `quiz/review` 页面可自动继续到下一活动
- 章节内活动优先解析（优先同章节连续学习）
- 期末考试保护（默认检测到期末即停下，不自动进入）
- 防自循环保护（避免 `3.2 -> 3.2` 反复跳转）
- 视频卡住兜底跳过（长时间无进度后尝试下一活动）
- 右下角状态浮窗 + 控制台诊断日志

---

## 安装方式

1. 安装 Userscript 管理器（Tampermonkey / Violentmonkey）。
2. 新建脚本。
3. 粘贴 `sysu_lms_auto_player.user.js` 内容并保存。
4. 打开 LMS 对应页面使用。

脚本匹配页面：

- `https://lms.sysu.edu.cn/mod/fsresource/view.php*`
- `https://lms.sysu.edu.cn/mod/quiz/review.php*`

---

## 使用说明（推荐流程）

### 1) 启动脚本

1. 进入课程任意视频页（建议从章节首个视频开始）。
2. 等待右下角出现“LMS 自动学习助手”浮窗。
3. 脚本会自动尝试播放并显示当前状态。

### 2) 自动学习过程

1. 当前视频播放结束后，脚本会自动寻找并跳转到下一活动。
2. 章节中间视频：通常会跳到下一节视频（如 `3.2 -> 3.3`）。
3. 章节末尾视频：会优先跳到本章节小测（若课程结构如此设置）。
4. 在小测答题页请手动完成并提交。
5. 进入 `quiz/review` 回顾页后，脚本可自动继续下一活动（可配置关闭）。

### 3) 期末考试处理

1. 默认开启期末保护（`stopBeforeFinalExam=true`）。
2. 当下一活动识别为“期末考试”时，脚本会停止自动跳转并提示你手动开始。

### 4) 异常时怎么处理

1. 若出现“反复跳同一页”，脚本会触发防自循环阻断并暂停自动跳转。
2. 可先手动点击正确的下一活动继续；然后刷新页面重试。
3. 打开浏览器 Console，检查关键词：
   - `下一活动解析来源`
   - `same-as-current`
   - `self-loop-blocked`
   - `未找到下一活动`

---

## 配置说明

脚本顶部 `CONFIG` 如下：

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

参数说明：

- `playbackRate`：播放倍速。
- `videoLoadTimeout`：等待视频元素超时时间（毫秒）。
- `retryDelay`：加载失败后重试间隔（毫秒）。
- `maxRetries`：最大重试次数。
- `nextPageDelay`：跳转下一活动前的延迟（毫秒）。
- `skipCompleted`：是否跳过进度 100% 的视频。
- `autoContinueFromQuizReview`：在小测回顾页是否自动继续。
- `stopBeforeFinalExam`：下一活动为期末考试时是否停止自动跳转。
- `loopGuardWindowMs`：循环保护统计窗口（毫秒）。
- `loopGuardMaxRepeats`：窗口内同目标重复跳转达到该次数后触发阻断。

---

## 工作流程

### 1) 视频页（`mod/fsresource/view.php`）

1. 初始化并检查是否已完成。
2. 若 `skipCompleted=true` 且进度 100%，直接尝试下一活动。
3. 等待视频元素，重试加载。
4. 自动播放并设置倍速。
5. 监听 `ended` 事件，触发 `goToNextActivity()`。
6. 若检测到卡住（连续多次无进度），触发兜底跳转。

### 2) 小测回顾页（`mod/quiz/review.php`）

1. 若 `autoContinueFromQuizReview=true`，自动继续下一活动。
2. 否则停在当前页等待手动操作。

---

## 下一活动解析逻辑（v1.3.0）

脚本会并行收集候选，并按稳定优先级选择：

1. `next-link`：`#next-activity-link`
2. `nav-tree`：左侧课程导航树中的同章节后续活动
3. `select`：`#jump-to-activity` / `select[name="jump"]`
4. `section-quiz-fallback`：同章节后续非期末小测兜底

统一规则：

- 所有来源都经过“同活动过滤”：
  - 先比 `id/cmid`
  - 再比 `pathname`
- 过滤后仍命中当前页则记为 `same-as-current`，不会用于跳转。

---

## 防自循环机制

为避免出现 `3.2 -> 3.2` 循环，脚本有两层保护：

1. **硬校验保护**
   - `goToNextActivity()` 最终跳转前再次校验目标是否等于当前活动。
   - 若相同，记录 `self-loop-blocked`，并排除该来源后重算一次。
   - 若重算后仍相同，则停止自动跳转并提示手动处理。

2. **短时循环保护**
   - 使用 `sessionStorage` 记录最近跳转对（当前页 -> 目标页）。
   - 在 `loopGuardWindowMs` 内，若同一跳转重复达到 `loopGuardMaxRepeats`，触发阻断并停止自动跳转。

---

## 期末保护说明

当 `stopBeforeFinalExam=true` 时：

- 若解析出的下一活动是期末考试（quiz 且标题匹配“期末/final”），脚本会停止自动跳转并提示手动开始。

---

## 关键日志关键词

可在浏览器控制台（Console）搜索：

- `下一活动解析来源`：查看本次跳转使用了哪个来源
- `same-as-current`：候选被判定为当前页并被过滤
- `self-loop-blocked`：触发了防自循环阻断
- `未找到下一活动`：所有来源均未产出可用候选

---

## 常见问题

### 1. 视频结束后没有跳转

- 看控制台是否有 `未找到下一活动`。
- 检查 LMS 页面结构是否变化（选择器失效）。
- 检查是否命中期末保护。

### 2. 发生 `3.2 -> 3.2` 循环

- 新版已加入同页过滤和循环保护。
- 若仍出现，提供控制台中包含 `same-as-current` / `self-loop-blocked` 的日志片段以便继续定位。

### 3. 跳到小测后不继续

- 检查是否在 `quiz/review` 页面。
- 确认 `autoContinueFromQuizReview` 为 `true`。

---

## 免责声明

本脚本用于减少重复点击操作，请遵守课程平台与课程要求，合理使用。

