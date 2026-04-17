// ==UserScript==
// @name         中山大学 LMS 视频自动播放器
// @namespace    https://lms.sysu.edu.cn/
// @version      1.0.0
// @description  自动播放课程视频，结束后自动跳转到下一个视频
// @author       You
// @match        https://lms.sysu.edu.cn/mod/fsresource/view.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // ⚙️ 配置区（按需修改）
    // ============================================================
    const CONFIG = {
        // 播放倍速：1 = 正常，1.5 / 2 = 加速（视网站是否限速而定）
        playbackRate: 1.5,

        // 视频加载超时（毫秒）：超过此时间未找到 video 元素则重试
        videoLoadTimeout: 15000,

        // 视频播放失败后等待重试的时间（毫秒）
        retryDelay: 5000,

        // 最大重试次数
        maxRetries: 3,

        // 跳转到下一页前的延迟（毫秒），防止太快触发反爬机制
        nextPageDelay: 1500,

        // 是否跳过已完成（进度100%）的视频
        skipCompleted: true,
    };

    // ============================================================
    // 🪵 日志工具
    // ============================================================
    const log = (msg, type = 'info') => {
        const styles = {
            info:    'background:#1a73e8;color:#fff;padding:2px 6px;border-radius:3px;',
            success: 'background:#34a853;color:#fff;padding:2px 6px;border-radius:3px;',
            warn:    'background:#fbbc04;color:#000;padding:2px 6px;border-radius:3px;',
            error:   'background:#ea4335;color:#fff;padding:2px 6px;border-radius:3px;',
        };
        console.log(`%c[LMS Auto Player] ${msg}`, styles[type] || styles.info);
    };

    // ============================================================
    // 🎬 步骤 1：等待 video 元素出现
    // ============================================================
    function waitForVideo(timeout = CONFIG.videoLoadTimeout) {
        return new Promise((resolve, reject) => {
            // 先检查是否已存在
            const existing = document.querySelector('video#fsplayer-container-id_html5_api');
            if (existing && existing.readyState >= 1) {
                return resolve(existing);
            }

            const startTime = Date.now();
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

    // ============================================================
    // ▶️ 步骤 2：点击播放按钮，触发视频开始
    // ============================================================
    function tryPlay(video) {
        // 优先尝试点击 video.js 大播放按钮（避免浏览器自动播放策略拦截）
        const bigPlayBtn = document.querySelector('.vjs-big-play-button');
        if (bigPlayBtn && !bigPlayBtn.classList.contains('vjs-hidden')) {
            log('点击大播放按钮');
            bigPlayBtn.click();
        }

        // 同时也对 video 元素调用 play()，作为后备
        const playPromise = video.play();
        if (playPromise !== undefined) {
            playPromise.catch(err => {
                log(`play() 被拦截：${err.message}，等待用户交互后自动重试`, 'warn');
                // 绑定一次性点击事件：下次用户点击页面时再播放
                document.addEventListener('click', () => video.play(), { once: true });
            });
        }

        // 设置倍速
        video.playbackRate = CONFIG.playbackRate;
        log(`倍速已设置为 ${CONFIG.playbackRate}x`);
    }

    // ============================================================
    // 📊 步骤 3：检查当前视频是否已完成（进度100%）
    // ============================================================
    function isAlreadyCompleted() {
        const progressEl = document.querySelector('.num-bfjd span');
        if (progressEl) {
            const progress = parseInt(progressEl.textContent, 10);
            log(`当前播放进度：${progress}%`);
            return progress >= 100;
        }
        return false;
    }

    // ============================================================
    // ⏭️ 步骤 4：获取下一个视频的 URL
    // ============================================================
    function getNextVideoUrl() {
        // 方法 A：读取页面内的视频选择下拉框
        const select = document.querySelector('select[name="jump"], .fsresource-nav select, select');
        if (select) {
            const options = Array.from(select.options);
            const currentIndex = select.selectedIndex;
            // 找到下一个 fsresource 视频（跳过测验等非视频条目）
            for (let i = currentIndex + 1; i < options.length; i++) {
                if (options[i].value.includes('/mod/fsresource/')) {
                    const url = new URL(options[i].value, window.location.origin);
                    // 确保携带 forceview 参数（让平台记录进度）
                    url.searchParams.set('forceview', '1');
                    log(`下一视频（选择器）：${options[i].text.trim()}`);
                    return url.href;
                }
            }
        }

        // 方法 B：读取页面内的"下一个活动"链接
        const nextLink = document.querySelector('#next-activity-link, a[id*="next"]');
        if (nextLink && nextLink.href) {
            log(`下一视频（下一页链接）：${nextLink.href}`);
            return nextLink.href;
        }

        log('已是最后一个视频，没有下一页了', 'warn');
        return null;
    }

    // ============================================================
    // 🔄 步骤 5：跳转到下一个视频页面
    // ============================================================
    function goToNextVideo() {
        const nextUrl = getNextVideoUrl();
        if (nextUrl) {
            log(`${CONFIG.nextPageDelay}ms 后跳转到下一视频...`, 'success');
            setTimeout(() => {
                window.location.href = nextUrl;
            }, CONFIG.nextPageDelay);
        } else {
            log('🎉 所有视频已播放完成！', 'success');
            showDoneNotice();
        }
    }

    // ============================================================
    // 🖥️ UI：在页面右下角显示状态浮窗
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
            max-width: 280px; line-height: 1.6;
        `;
        document.body.appendChild(ui);
        return ui;
    }

    function updateStatus(msg) {
        const ui = createStatusUI();
        ui.innerHTML = `
            <div style="font-weight:bold;margin-bottom:4px;">🤖 LMS 自动播放</div>
            <div>${msg}</div>
        `;
    }

    function showDoneNotice() {
        updateStatus('🎉 所有视频已播放完毕！');
        document.getElementById('lms-auto-player-ui').style.background = 'rgba(52,168,83,0.95)';
    }

    // ============================================================
    // 🚀 主流程入口
    // ============================================================
    async function main() {
        let retryCount = 0;

        log('脚本启动，当前页面：' + window.location.href);
        updateStatus('⏳ 正在初始化...');

        // — 检查是否已完成，可选跳过 —
        if (CONFIG.skipCompleted && isAlreadyCompleted()) {
            log('此视频已完成（100%），直接跳转下一个', 'success');
            updateStatus('✅ 已完成，跳过中...');
            goToNextVideo();
            return;
        }

        // — 等待视频加载 —
        let video;
        while (retryCount < CONFIG.maxRetries) {
            try {
                updateStatus('⏳ 等待播放器加载...');
                video = await waitForVideo();
                log('视频元素已找到', 'success');
                break;
            } catch (e) {
                retryCount++;
                log(`第 ${retryCount} 次重试（${e.message}）`, 'warn');
                updateStatus(`⚠️ 加载超时，第 ${retryCount} 次重试...`);
                if (retryCount >= CONFIG.maxRetries) {
                    log('已超过最大重试次数，请刷新页面', 'error');
                    updateStatus('❌ 加载失败，请手动刷新页面');
                    return;
                }
                await new Promise(r => setTimeout(r, CONFIG.retryDelay));
            }
        }

        // — 触发播放 —
        updateStatus('▶️ 正在尝试播放...');
        tryPlay(video);

        // — 监听播放状态 —
        video.addEventListener('playing', () => {
            log('视频开始播放！', 'success');
            const title = document.title.replace(' | 中山大学在线教学平台', '').trim();
            updateStatus(`▶️ 正在播放：${title}<br>⏱ 倍速：${CONFIG.playbackRate}x`);
        });

        video.addEventListener('pause', () => {
            // 意外暂停时（非用户主动）自动恢复
            // 注：ended 之后也会触发 pause，需排除
            if (!video.ended) {
                log('视频意外暂停，自动恢复', 'warn');
                updateStatus('⚠️ 视频已暂停，尝试恢复...');
                setTimeout(() => {
                    if (video.paused && !video.ended) video.play();
                }, 1000);
            }
        });

        video.addEventListener('error', () => {
            log(`视频播放错误：code=${video.error?.code}`, 'error');
            updateStatus('❌ 播放出错，请检查网络或刷新页面');
        });

        video.addEventListener('waiting', () => {
            log('视频缓冲中...', 'warn');
            updateStatus('⏳ 缓冲中，请稍候...');
        });

        // — 视频结束，跳转下一个 —
        video.addEventListener('ended', () => {
            log('视频播放完毕！', 'success');
            updateStatus('✅ 视频已播完，即将跳转...');
            goToNextVideo();
        });

        // — 兜底：视频卡住检测（每30秒检查一次进度是否推进）—
        let lastTime = -1;
        let stuckCount = 0;
        const stuckChecker = setInterval(() => {
            if (video.ended) {
                clearInterval(stuckChecker);
                return;
            }
            if (!video.paused) {
                if (video.currentTime === lastTime) {
                    stuckCount++;
                    log(`视频可能卡住（${stuckCount}/3），currentTime=${video.currentTime}`, 'warn');
                    if (stuckCount >= 3) {
                        clearInterval(stuckChecker);
                        log('视频卡住超过 90 秒，跳转到下一个', 'error');
                        updateStatus('⚠️ 视频长时间无进度，跳过...');
                        goToNextVideo();
                    }
                } else {
                    stuckCount = 0;
                }
                lastTime = video.currentTime;
            }
        }, 30000);
    }

    // 等待页面完全加载后启动
    if (document.readyState === 'complete') {
        main();
    } else {
        window.addEventListener('load', main);
    }

})();
