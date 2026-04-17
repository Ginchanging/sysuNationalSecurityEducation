// ==UserScript==
// @name         中山大学 LMS 自动学习助手
// @namespace    https://lms.sysu.edu.cn/
// @version      1.3.1
// @description  自动播放课程视频并按活动顺序跳转（章节小测优先，期末默认停下）
// @author       You
// @match        https://lms.sysu.edu.cn/mod/fsresource/view.php*
// @match        https://lms.sysu.edu.cn/mod/quiz/review.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // 配置区（按需修改）
    // ============================================================
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

    const LOOP_GUARD_KEY = 'lms-auto-player-loop-guard-v1';

    // ============================================================
    // 日志与基础工具
    // ============================================================
    const log = (msg, type = 'info') => {
        const styles = {
            info: 'background:#1a73e8;color:#fff;padding:2px 6px;border-radius:3px;',
            success: 'background:#34a853;color:#fff;padding:2px 6px;border-radius:3px;',
            warn: 'background:#fbbc04;color:#000;padding:2px 6px;border-radius:3px;',
            error: 'background:#ea4335;color:#fff;padding:2px 6px;border-radius:3px;',
        };
        console.log(`%c[LMS Auto Player] ${msg}`, styles[type] || styles.info);
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const escapeHtml = (text) =>
        String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

    function normalizeActivityTitle(title) {
        return String(title || '')
            .replace(/[◆▶►▸]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getActivityType(pathname) {
        const path = String(pathname || '').toLowerCase();
        if (path.includes('/mod/fsresource/')) return 'fsresource';
        if (path.includes('/mod/quiz/')) return 'quiz';
        return 'other';
    }

    function isFinalQuizTitle(title) {
        return /期末|final/i.test(normalizeActivityTitle(title));
    }

    function parseActivity(rawUrl, rawTitle = '') {
        try {
            const url = new URL(rawUrl, window.location.origin);
            const path = url.pathname.toLowerCase();
            const type = getActivityType(path);
            const moduleId = url.searchParams.get('id') || url.searchParams.get('cmid') || '';
            const title = normalizeActivityTitle(rawTitle);

            if (path.startsWith('/mod/')) {
                url.searchParams.set('forceview', '1');
            }

            return {
                url: url.href,
                title,
                type,
                moduleId,
                path,
                isFinal: type === 'quiz' && isFinalQuizTitle(title),
            };
        } catch {
            return null;
        }
    }

    function withSource(activity, source) {
        return activity ? { ...activity, source } : null;
    }

    function withRejectReason(activity, rejectReason) {
        return activity ? { ...activity, rejectReason } : null;
    }

    function getCurrentActivityContext() {
        const url = new URL(window.location.href);
        return {
            url: url.href,
            path: url.pathname.toLowerCase(),
            moduleId: url.searchParams.get('id') || url.searchParams.get('cmid') || '',
        };
    }

    function isSameActivityByIdOrPath(a, b) {
        if (!a || !b) return false;

        const aId = String(a.moduleId || '').trim();
        const bId = String(b.moduleId || '').trim();
        if (aId && bId) return aId === bId;

        return String(a.path || '').toLowerCase() === String(b.path || '').toLowerCase();
    }

    function activityKey(activity) {
        if (!activity) return '';
        if (activity.moduleId) return `id:${activity.moduleId}`;
        return `path:${String(activity.path || '').toLowerCase()}`;
    }

    function dedupeActivities(activities) {
        const map = new Map();
        for (const item of activities) {
            const key = activityKey(item);
            if (!key || map.has(key)) continue;
            map.set(key, item);
        }
        return Array.from(map.values());
    }

    function rejectSameAsCurrent(activity, source, current) {
        if (!activity) return { activity: null, reason: `invalid-${source}` };
        if (isSameActivityByIdOrPath(activity, current)) {
            log(`忽略候选(${source})：same-as-current -> ${activity.title || activity.url}`, 'warn');
            return {
                activity: withRejectReason(withSource(activity, source), 'same-as-current'),
                reason: 'same-as-current',
            };
        }
        return { activity: withSource(activity, source), reason: null };
    }

    // ============================================================
    // UI：状态浮窗
    // ============================================================
    function createStatusUI() {
        const existing = document.getElementById('lms-auto-player-ui');
        if (existing) return existing;

        const ui = document.createElement('div');
        ui.id = 'lms-auto-player-ui';
        ui.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 99999;
            background: rgba(26,115,232,0.95); color: white;
            padding: 12px 16px; border-radius: 10px;
            font-size: 13px; font-family: sans-serif;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            max-width: 360px; line-height: 1.6;
        `;
        document.body.appendChild(ui);
        return ui;
    }

    function updateStatus(msg) {
        const ui = createStatusUI();
        ui.innerHTML = `
            <div style="font-weight:bold;margin-bottom:4px;">LMS 自动学习助手</div>
            <div>${msg}</div>
        `;
    }

    function showDoneNotice(message = '当前课程活动已到末尾。') {
        updateStatus(`已完成： ${escapeHtml(message)}`);
        const ui = document.getElementById('lms-auto-player-ui');
        if (ui) ui.style.background = 'rgba(52,168,83,0.95)';
    }

    // ============================================================
    // 循环保护
    // ============================================================
    function readLoopGuard() {
        try {
            const raw = sessionStorage.getItem(LOOP_GUARD_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    function writeLoopGuard(data) {
        try {
            sessionStorage.setItem(LOOP_GUARD_KEY, JSON.stringify(data));
        } catch {
            // ignore
        }
    }

    function isJumpLoopBlocked(current, target) {
        const now = Date.now();
        const currentKey = activityKey(current);
        const targetKey = activityKey(target);

        let guard = readLoopGuard();
        if (!guard || now - Number(guard.timestamp || 0) > CONFIG.loopGuardWindowMs) {
            guard = { currentKey, targetKey, count: 1, timestamp: now };
            writeLoopGuard(guard);
            return false;
        }

        if (guard.currentKey === currentKey && guard.targetKey === targetKey) {
            guard.count = Number(guard.count || 0) + 1;
            guard.timestamp = now;
            writeLoopGuard(guard);
            return guard.count >= CONFIG.loopGuardMaxRepeats;
        }

        guard = { currentKey, targetKey, count: 1, timestamp: now };
        writeLoopGuard(guard);
        return false;
    }

    // ============================================================
    // 下一活动解析（多来源 + 优先级）
    // ============================================================
    function getNextActivityFromNextLink(current) {
        const nextLink = document.querySelector('#next-activity-link');
        if (!nextLink || !nextLink.href) {
            return { activity: null, reason: 'no-next-link' };
        }

        const activity = parseActivity(nextLink.href, nextLink.textContent || '');
        return rejectSameAsCurrent(activity, 'next-link', current);
    }

    function getNextActivityFromSelect(current) {
        const select = document.querySelector('#jump-to-activity, select[name="jump"], .fsresource-nav select');
        if (!select) {
            return { activity: null, reason: 'no-select' };
        }

        const optionActivities = dedupeActivities(
            Array.from(select.options)
                .filter((option) => option.value && option.value.trim())
                .map((option) => parseActivity(option.value, option.textContent || ''))
                .filter(Boolean)
        );

        if (optionActivities.length === 0) {
            return { activity: null, reason: 'no-valid-options' };
        }

        let currentIndex = optionActivities.findIndex((activity) => isSameActivityByIdOrPath(activity, current));
        if (currentIndex < 0 && select.selectedIndex >= 0) {
            const selected = select.options[select.selectedIndex];
            const selectedActivity =
                selected && selected.value ? parseActivity(selected.value, selected.textContent || '') : null;
            currentIndex = optionActivities.findIndex(
                (activity) => selectedActivity && isSameActivityByIdOrPath(activity, selectedActivity)
            );
        }

        if (currentIndex < 0) {
            return { activity: null, reason: 'missing-current-index' };
        }

        for (let i = currentIndex + 1; i < optionActivities.length; i++) {
            const candidate = optionActivities[i];
            if (!isSameActivityByIdOrPath(candidate, current)) {
                return { activity: withSource(candidate, 'select'), reason: null };
            }
        }

        return { activity: null, reason: 'no-next-after-current' };
    }

    function findCurrentNavActivityItem(current) {
        const activityItems = Array.from(document.querySelectorAll('li.type_activity'));
        for (const item of activityItems) {
            const anchor = item.querySelector('a[href*="/mod/"]');
            if (!anchor) continue;
            const activity = parseActivity(anchor.getAttribute('href'), anchor.textContent || '');
            if (isSameActivityByIdOrPath(activity, current)) return item;
        }

        const activeAnchor = document.querySelector(
            'p.active_tree_node a[href*="/mod/"], li.current_branch p.tree_item a[href*="/mod/"]'
        );
        return activeAnchor ? activeAnchor.closest('li.type_activity') : null;
    }

    function analyzeSectionNavTree(current) {
        const currentItem = findCurrentNavActivityItem(current);
        if (!currentItem) {
            return {
                nextInSection: null,
                nextNonFinalQuizAfterCurrent: null,
                reason: 'missing-current-index',
            };
        }

        const sectionContainer = currentItem.closest('li.type_structure');
        if (!sectionContainer) {
            return {
                nextInSection: null,
                nextNonFinalQuizAfterCurrent: null,
                reason: 'no-section-container',
            };
        }

        const sectionActivities = dedupeActivities(
            Array.from(sectionContainer.querySelectorAll('li.type_activity a[href*="/mod/"]'))
                .map((anchor) => parseActivity(anchor.getAttribute('href'), anchor.textContent || ''))
                .filter(Boolean)
        );

        if (sectionActivities.length === 0) {
            return {
                nextInSection: null,
                nextNonFinalQuizAfterCurrent: null,
                reason: 'no-section-activities',
            };
        }

        let currentIndex = sectionActivities.findIndex((activity) => isSameActivityByIdOrPath(activity, current));
        if (currentIndex < 0) {
            const currentAnchor = currentItem.querySelector('a[href*="/mod/"]');
            const treeCurrent = currentAnchor
                ? parseActivity(currentAnchor.getAttribute('href'), currentAnchor.textContent || '')
                : null;
            currentIndex = sectionActivities.findIndex(
                (activity) => treeCurrent && isSameActivityByIdOrPath(activity, treeCurrent)
            );
        }

        if (currentIndex < 0) {
            return {
                nextInSection: null,
                nextNonFinalQuizAfterCurrent: null,
                reason: 'missing-current-index',
            };
        }

        const afterCurrent = sectionActivities
            .slice(currentIndex + 1)
            .filter((activity) => !isSameActivityByIdOrPath(activity, current));

        const nextInSection = afterCurrent[0] ? withSource(afterCurrent[0], 'nav-tree') : null;
        const nextNonFinalQuiz = afterCurrent.find((activity) => activity.type === 'quiz' && !activity.isFinal);

        if (!nextInSection && !nextNonFinalQuiz) {
            return {
                nextInSection: null,
                nextNonFinalQuizAfterCurrent: null,
                reason: 'no-nonfinal-quiz-after-current',
            };
        }

        return {
            nextInSection,
            nextNonFinalQuizAfterCurrent: nextNonFinalQuiz
                ? withSource(nextNonFinalQuiz, 'section-quiz-fallback')
                : null,
            reason: null,
        };
    }

    function getNextActivity(options = {}) {
        const current = options.current || getCurrentActivityContext();
        const excludedSources = new Set(options.excludedSources || []);
        const diagnostics = [];
        const candidates = new Map();

        const nextLinkResult = getNextActivityFromNextLink(current);
        if (nextLinkResult.reason) diagnostics.push(`next-link:${nextLinkResult.reason}`);
        if (nextLinkResult.activity) candidates.set('next-link', nextLinkResult.activity);

        const navTreeResult = analyzeSectionNavTree(current);
        if (navTreeResult.reason) diagnostics.push(`nav-tree:${navTreeResult.reason}`);
        if (navTreeResult.nextInSection) candidates.set('nav-tree', navTreeResult.nextInSection);

        const selectResult = getNextActivityFromSelect(current);
        if (selectResult.reason) diagnostics.push(`select:${selectResult.reason}`);
        if (selectResult.activity) candidates.set('select', selectResult.activity);

        if (navTreeResult.nextNonFinalQuizAfterCurrent) {
            candidates.set('section-quiz-fallback', navTreeResult.nextNonFinalQuizAfterCurrent);
        }

        const sourceOrder = ['next-link', 'nav-tree', 'select', 'section-quiz-fallback'];
        for (const source of sourceOrder) {
            if (excludedSources.has(source)) continue;
            const candidate = candidates.get(source);
            if (!candidate) continue;
            if (isSameActivityByIdOrPath(candidate, current)) {
                diagnostics.push(`${source}:same-as-current`);
                continue;
            }
            log(`下一活动解析来源：${source} -> ${candidate.title || candidate.url}`);
            return candidate;
        }

        log(`未找到下一活动，失败原因：${diagnostics.join(' | ') || 'unknown'}`, 'warn');
        return null;
    }

    function goToNextActivity() {
        const current = getCurrentActivityContext();
        let nextActivity = getNextActivity({ current });

        if (!nextActivity) {
            log('没有下一活动，流程结束', 'success');
            showDoneNotice();
            return;
        }

        if (isSameActivityByIdOrPath(nextActivity, current)) {
            log(`self-loop-blocked: 首次解析命中当前页，来源=${nextActivity.source || 'unknown'}`, 'error');
            nextActivity = getNextActivity({
                current,
                excludedSources: [nextActivity.source].filter(Boolean),
            });
            if (!nextActivity || isSameActivityByIdOrPath(nextActivity, current)) {
                log('self-loop-blocked: 降级重算后仍是当前页，停止自动跳转', 'error');
                updateStatus('检测到重复跳转风险，已停止自动跳转，请手动进入下一活动。');
                return;
            }
        }

        if (CONFIG.stopBeforeFinalExam && nextActivity.isFinal) {
            log('检测到下一活动为期末考试，按配置停止自动跳转', 'warn');
            updateStatus('已到期末考试，按配置停止自动跳转，请手动开始。');
            return;
        }

        if (isJumpLoopBlocked(current, nextActivity)) {
            log(
                `self-loop-blocked: 1分钟内重复跳到同一目标过多次 -> ${nextActivity.title || nextActivity.url}`,
                'error'
            );
            updateStatus('检测到短时重复跳转循环，已暂停自动跳转，请手动检查。');
            return;
        }

        const target = escapeHtml(nextActivity.title || nextActivity.url);
        log(
            `${CONFIG.nextPageDelay}ms 后跳转到下一活动 [${nextActivity.source || 'unknown'}]：${nextActivity.title || nextActivity.url}`,
            'success'
        );
        updateStatus(`即将跳转到下一活动：${target}`);

        setTimeout(() => {
            window.location.href = nextActivity.url;
        }, CONFIG.nextPageDelay);
    }

    // ============================================================
    // 视频页逻辑（mod/fsresource/view.php）
    // ============================================================
    function waitForVideo(timeout = CONFIG.videoLoadTimeout) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector('video#fsplayer-container-id_html5_api');
            if (existing && existing.readyState >= 1) {
                return resolve(existing);
            }

            const observer = new MutationObserver(() => {
                const video = document.querySelector('video#fsplayer-container-id_html5_api');
                if (video) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(video);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error('视频元素加载超时'));
            }, timeout);
        });
    }

    function tryPlay(video) {
        const bigPlayBtn = document.querySelector('.vjs-big-play-button');
        if (bigPlayBtn && !bigPlayBtn.classList.contains('vjs-hidden')) {
            log('点击大播放按钮');
            bigPlayBtn.click();
        }

        const playPromise = video.play();
        if (playPromise !== undefined) {
            playPromise.catch((err) => {
                log(`play() 被拦截：${err.message}，等待用户交互后自动重试`, 'warn');
                document.addEventListener('click', () => video.play(), { once: true });
            });
        }

        video.playbackRate = CONFIG.playbackRate;
        log(`倍速已设置为 ${CONFIG.playbackRate}x`);
    }

    function getWatchProgressPercent() {
        const progressEl = document.querySelector('.num-bfjd span');
        if (!progressEl) return null;

        const raw = String(progressEl.textContent || '').trim();
        if (!raw) return null;

        const value = Number.parseFloat(raw.replace('%', '').replace(/[^\d.]/g, ''));
        return Number.isFinite(value) ? value : null;
    }

    function isWatchProgressComplete(progress = getWatchProgressPercent()) {
        return Number.isFinite(progress) && progress >= 100;
    }

    async function waitForProgressSyncAfterEnded(maxWaitMs = 5000, intervalMs = 500) {
        const startAt = Date.now();
        let latestProgress = getWatchProgressPercent();

        while (Date.now() - startAt < maxWaitMs) {
            if (isWatchProgressComplete(latestProgress)) {
                return latestProgress;
            }

            await sleep(intervalMs);
            const next = getWatchProgressPercent();
            if (Number.isFinite(next)) {
                latestProgress = next;
            }
        }

        return latestProgress;
    }

    function restartCurrentVideo(video, reason = 'progress-incomplete') {
        const progress = getWatchProgressPercent();
        const safeProgress = Number.isFinite(progress) ? progress.toFixed(1) : 'N/A';

        log(`Watch progress ${safeProgress}% is not complete (${reason}), restart current video`, 'warn');
        updateStatus(`进度 ${safeProgress}% < 100%，自动重播当前视频...`);

        try {
            video.currentTime = 0;
        } catch (error) {
            log(`Reset currentTime failed: ${error.message}`, 'warn');
        }

        tryPlay(video);
    }

    function isAlreadyCompleted() {
        const progress = getWatchProgressPercent();
        if (!Number.isFinite(progress)) {
            log('未读取到观看进度，按未完成处理', 'warn');
            return false;
        }

        log(`当前播放进度：${progress.toFixed(1)}%`);
        return isWatchProgressComplete(progress);
    }

    async function runFsresourcePage() {
        let retryCount = 0;
        updateStatus('正在初始化视频自动播放...');

        if (CONFIG.skipCompleted && isAlreadyCompleted()) {
            log('当前视频观看进度已达 100%，直接进入下一活动', 'success');
            updateStatus('当前视频已完成，准备跳转下一活动...');
            goToNextActivity();
            return;
        }

        let video;
        while (retryCount < CONFIG.maxRetries) {
            try {
                updateStatus('等待播放器加载...');
                video = await waitForVideo();
                log('已找到视频元素', 'success');
                break;
            } catch (e) {
                retryCount++;
                log(`第 ${retryCount} 次重试（${e.message}）`, 'warn');
                updateStatus(`加载超时，正在第 ${retryCount} 次重试...`);
                if (retryCount >= CONFIG.maxRetries) {
                    log('超过最大重试次数，请手动刷新页面', 'error');
                    updateStatus('加载失败，请手动刷新页面');
                    return;
                }
                await sleep(CONFIG.retryDelay);
            }
        }

        updateStatus('正在尝试播放视频...');
        tryPlay(video);

        let hasNavigated = false;
        let progressWatcher = null;
        let stuckChecker = null;

        const clearRuntimeTimers = () => {
            if (progressWatcher) {
                clearInterval(progressWatcher);
                progressWatcher = null;
            }
            if (stuckChecker) {
                clearInterval(stuckChecker);
                stuckChecker = null;
            }
        };

        const tryGoNextWhenProgressComplete = (trigger, progress = getWatchProgressPercent()) => {
            const safeProgress = Number.isFinite(progress) ? progress.toFixed(1) : 'N/A';

            if (!isWatchProgressComplete(progress)) return false;
            if (hasNavigated) {
                log(`已触发跳转，忽略重复请求（${trigger}）`, 'info');
                return true;
            }

            hasNavigated = true;
            clearRuntimeTimers();
            log(`观看进度已达 ${safeProgress}%（${trigger}），立即跳转下一活动`, 'success');
            updateStatus('观看进度达到 100%，即将跳转下一活动...');
            goToNextActivity();
            return true;
        };

        progressWatcher = setInterval(() => {
            const progress = getWatchProgressPercent();
            if (!Number.isFinite(progress)) return;
            if (isWatchProgressComplete(progress)) {
                tryGoNextWhenProgressComplete('progress-watcher', progress);
            }
        }, 1000);

        window.addEventListener(
            'pagehide',
            () => {
                clearRuntimeTimers();
            },
            { once: true }
        );

        video.addEventListener('playing', () => {
            log('视频开始播放', 'success');
            const title = document.title.replace(/\s*\|\s*中山大学在线教学平台\s*$/, '').trim() || '当前视频';
            updateStatus(`正在播放：${escapeHtml(title)}<br>倍速：${CONFIG.playbackRate}x`);
        });

        video.addEventListener('pause', () => {
            if (!video.ended) {
                log('视频意外暂停，尝试自动恢复', 'warn');
                updateStatus('视频暂停，正在尝试恢复播放...');
                setTimeout(() => {
                    if (video.paused && !video.ended) {
                        video.play().catch(() => {});
                    }
                }, 1000);
            }
        });

        video.addEventListener('error', () => {
            log(`视频播放错误：code=${video.error?.code}`, 'error');
            updateStatus('视频播放出错，请检查网络或刷新页面');
        });

        video.addEventListener('waiting', () => {
            log('视频缓冲中', 'warn');
            updateStatus('视频缓冲中，请稍候...');
        });

        video.addEventListener('ended', async () => {
            if (video.__lmsHandlingEnded) return;
            video.__lmsHandlingEnded = true;

            try {
                log('视频播放结束，正在校验观看进度', 'info');
                updateStatus('视频结束，正在同步观看进度...');

                const syncedProgress = await waitForProgressSyncAfterEnded();
                const safeProgress = Number.isFinite(syncedProgress) ? syncedProgress.toFixed(1) : 'N/A';

                if (tryGoNextWhenProgressComplete('ended-sync', syncedProgress)) {
                    return;
                }

                log(`观看进度仅 ${safeProgress}%，未到 100%，重播当前视频`, 'warn');
                restartCurrentVideo(video, 'progress-not-complete-after-ended');
            } finally {
                video.__lmsHandlingEnded = false;
            }
        });

        let lastTime = -1;
        let stuckCount = 0;
        stuckChecker = setInterval(() => {
            if (video.ended) {
                clearInterval(stuckChecker);
                return;
            }

            if (!video.paused) {
                if (video.currentTime === lastTime) {
                    stuckCount++;
                    log(`视频可能卡住（${stuckCount}/3），currentTime=${video.currentTime}`, 'warn');
                    if (stuckCount >= 3) {
                        const progress = getWatchProgressPercent();
                        const safeProgress = Number.isFinite(progress) ? progress.toFixed(1) : 'N/A';

                        if (tryGoNextWhenProgressComplete('stuck-checker', progress)) {
                            return;
                        }

                        log(`视频卡住且进度 ${safeProgress}% < 100%，尝试恢复/重播当前视频`, 'warn');
                        updateStatus(`视频长时间无进度（当前 ${safeProgress}%），尝试恢复播放...`);

                        try {
                            if (video.paused) {
                                tryPlay(video);
                            } else {
                                video.play().catch(() => {});
                            }
                        } catch {
                            // ignore and fallback to restart
                        }

                        if (video.currentTime === lastTime) {
                            restartCurrentVideo(video, 'stuck-with-incomplete-progress');
                        }
                        stuckCount = 0;
                    }
                } else {
                    stuckCount = 0;
                }
                lastTime = video.currentTime;
            }
        }, 30000);
    }

    // ============================================================
    // 小测回顾页逻辑（mod/quiz/review.php）    // ============================================================
    function runQuizReviewPage() {
        updateStatus('已进入小测回顾页');
        log('检测到 quiz/review 页面');

        if (!CONFIG.autoContinueFromQuizReview) {
            log('配置关闭：小测回顾页不自动继续', 'warn');
            updateStatus('已到小测回顾页，请手动进入下一活动。');
            return;
        }

        updateStatus('小测已提交，准备进入下一活动...');
        goToNextActivity();
    }

    // ============================================================
    // 启动入口
    // ============================================================
    function main() {
        const pathname = window.location.pathname.toLowerCase();
        log(`脚本启动，当前页面：${window.location.href}`);

        if (pathname.includes('/mod/fsresource/view.php')) {
            runFsresourcePage();
            return;
        }

        if (pathname.includes('/mod/quiz/review.php')) {
            runQuizReviewPage();
            return;
        }

        log('当前页面不在脚本处理范围内', 'warn');
    }

    if (document.readyState === 'complete') {
        main();
    } else {
        window.addEventListener('load', main);
    }
})();


