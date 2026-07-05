const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TELEGRAM_TIMEOUT_MS = 15000;
const TELEGRAM_PARSE_MODE = 'HTML';

// --- 辅助函数：转义 Telegram HTML 特殊字符 ---
function escapeTelegramHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatTelegramUserMessage(icon, username, body) {
    return `${icon} <b>${escapeTelegramHtml(username)}</b>\n${escapeTelegramHtml(body)}`;
}

// --- 辅助函数：发送 Telegram（图文合并为一条消息） ---
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        if (imagePath && fs.existsSync(imagePath)) {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('chat_id', TG_CHAT_ID);
            form.append('photo', fs.createReadStream(imagePath));
            form.append('caption', message);
            form.append('parse_mode', TELEGRAM_PARSE_MODE);
            await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, form, {
                headers: form.getHeaders(),
                timeout: TELEGRAM_TIMEOUT_MS,
                maxBodyLength: Infinity
            });
            console.log('[Telegram] Photo with caption sent.');
        } else {
            await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
                chat_id: TG_CHAT_ID,
                text: message,
                parse_mode: TELEGRAM_PARSE_MODE
            }, {
                timeout: TELEGRAM_TIMEOUT_MS,
                maxBodyLength: Infinity
            });
            console.log('[Telegram] Message sent.');
        }
    } catch (e) {
        console.error('[Telegram] Failed to send:', e.message);
    }
}

chromium.use(stealth);

const CHROME_PATH = resolveChromePath();
const DEBUG_PORT = 9222;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const RENEW_MAX_ATTEMPTS = 3;
const SCREENSHOT_SETTLE_MS = 1000;
const SCREENSHOT_RETRY_ATTEMPTS = 3;
const SCREENSHOT_MAX_VIEWPORT_HEIGHT = 2400;
const CHROME_START_TIMEOUT_MS = 45000;
const CHROME_START_RETRIES = 2;
const CHROME_LOG_PATH = path.join(process.cwd(), 'screenshots', 'chrome_startup.log');
process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。');
        process.exit(1);
    }
}

// --- 注入脚本：Hook Shadow DOM 获取 Turnstile 坐标 ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: parseInt(new URL(PROXY_CONFIG.server).port, 10),
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }
        await axios.get('https://1.1.1.1', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function resolveChromePath() {
    const configuredPath = process.env.CHROME_PATH;
    if (configuredPath) return configuredPath;

    const candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        'google-chrome',
        'google-chrome-stable',
        'chromium-browser',
        'chromium'
    ];

    for (const candidate of candidates) {
        if (path.isAbsolute(candidate)) {
            if (fs.existsSync(candidate)) return candidate;
            continue;
        }

        const result = spawnSync('which', [candidate], { encoding: 'utf8' });
        if (result.status === 0 && result.stdout.trim()) {
            return result.stdout.trim();
        }
    }

    return '/usr/bin/google-chrome';
}

function createChromeUserDataDir() {
    const safeRunId = String(process.env.GITHUB_RUN_ID || process.pid).replace(/[^a-z0-9_-]/gi, '_');
    return path.join('/tmp', `katabump_chrome_${safeRunId}_${Date.now()}`);
}

function readLogTail(filePath, maxChars = 6000) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return content.slice(-maxChars).trim();
    } catch (e) {
        return '';
    }
}

function printChromeStartupLog() {
    const tail = readLogTail(CHROME_LOG_PATH);
    if (tail) {
        console.error(`[Chrome] 启动日志尾部 (${CHROME_LOG_PATH}):\n${tail}`);
    } else {
        console.error(`[Chrome] 未读取到启动日志: ${CHROME_LOG_PATH}`);
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        let settled = false;
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                body += chunk;
                if (body.length > 10000) req.destroy();
            });
            res.on('end', () => {
                if (settled) return;
                settled = true;
                try {
                    const parsed = JSON.parse(body);
                    resolve(Boolean(parsed.Browser || parsed.webSocketDebuggerUrl));
                } catch (e) {
                    resolve(false);
                }
            });
        });
        req.on('error', () => {
            if (settled) return;
            settled = true;
            resolve(false);
        });
        req.setTimeout(3000, () => {
            if (settled) return;
            settled = true;
            req.destroy();
            resolve(false);
        });
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= CHROME_START_RETRIES; attempt++) {
        try {
            await startChromeProcess(attempt);
            return;
        } catch (e) {
            lastError = e;
            console.error(`[Chrome] 第 ${attempt}/${CHROME_START_RETRIES} 次启动失败: ${e.message}`);
            printChromeStartupLog();
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    throw lastError || new Error('Chrome 启动失败');
}

async function startChromeProcess(attempt) {
    const userDataDir = createChromeUserDataDir();
    fs.mkdirSync(path.dirname(CHROME_LOG_PATH), { recursive: true });
    fs.appendFileSync(CHROME_LOG_PATH, `\n\n=== Chrome launch attempt ${attempt} at ${new Date().toISOString()} ===\n`);

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH}, profile: ${userDataDir})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-gpu',
        '--force-device-scale-factor=1',
        '--disable-smooth-scrolling',
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--user-data-dir=${userDataDir}`,
        '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    const logFd = fs.openSync(CHROME_LOG_PATH, 'a');
    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd]
    });
    fs.closeSync(logFd);

    let spawnError = null;
    let exitDetails = null;
    chrome.once('error', (err) => {
        spawnError = err;
    });
    chrome.once('exit', (code, signal) => {
        exitDetails = { code, signal };
    });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    const startedAt = Date.now();
    while (Date.now() - startedAt < CHROME_START_TIMEOUT_MS) {
        if (spawnError) {
            throw spawnError;
        }
        if (exitDetails) {
            throw new Error(`Chrome 过早退出: code=${exitDetails.code}, signal=${exitDetails.signal}`);
        }
        if (await checkPort(DEBUG_PORT)) {
            console.log(`Chrome 初始化完成，用时 ${Math.ceil((Date.now() - startedAt) / 1000)} 秒。`);
            return;
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    throw new Error(`Chrome 在 ${Math.ceil(CHROME_START_TIMEOUT_MS / 1000)} 秒内未开放调试端口`);
}

async function configurePageViewport(page) {
    try {
        await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
        console.log(`[视口] 已设置为 ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`);
    } catch (e) {
        console.log('[视口] 设置失败:', e.message);
    }
}

async function waitForScreenshotReady(page) {
    await page.bringToFront().catch(() => {});
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.evaluate(async () => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const withTimeout = (promise, ms) => Promise.race([promise, sleep(ms)]);

        const styleId = '__screenshot_stabilizer__';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                *, *::before, *::after {
                    animation-duration: 0s !important;
                    animation-delay: 0s !important;
                    transition-duration: 0s !important;
                    transition-delay: 0s !important;
                    scroll-behavior: auto !important;
                }
                html, body {
                    scroll-behavior: auto !important;
                }
            `;
            document.documentElement.appendChild(style);
        }

        if (document.fonts && document.fonts.ready) {
            await withTimeout(document.fonts.ready.catch(() => {}), 2000);
        }

        const pendingImages = Array.from(document.images || []).filter((image) => !image.complete);
        if (pendingImages.length > 0) {
            await withTimeout(Promise.all(pendingImages.map((image) => new Promise((resolve) => {
                image.addEventListener('load', resolve, { once: true });
                image.addEventListener('error', resolve, { once: true });
            }))), 3000);
        }

        const body = document.body;
        const html = document.documentElement;
        const pageHeight = Math.max(
            body ? body.scrollHeight : 0,
            body ? body.offsetHeight : 0,
            html ? html.clientHeight : 0,
            html ? html.scrollHeight : 0,
            html ? html.offsetHeight : 0
        );
        const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
        const maxY = Math.max(0, pageHeight - window.innerHeight);

        for (let y = 0; y <= maxY; y += step) {
            window.scrollTo(0, y);
            await nextFrame();
            await sleep(80);
        }

        window.scrollTo(0, 0);
        await nextFrame();
        await nextFrame();
    }).catch(() => {});
    await page.waitForTimeout(SCREENSHOT_SETTLE_MS);
}

async function getPageScreenshotMetrics(page) {
    return await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        const scrollHeight = Math.ceil(Math.max(
            body ? body.scrollHeight : 0,
            body ? body.offsetHeight : 0,
            html ? html.clientHeight : 0,
            html ? html.scrollHeight : 0,
            html ? html.offsetHeight : 0,
            window.innerHeight || 0
        ));
        const scrollWidth = Math.ceil(Math.max(
            body ? body.scrollWidth : 0,
            body ? body.offsetWidth : 0,
            html ? html.clientWidth : 0,
            html ? html.scrollWidth : 0,
            html ? html.offsetWidth : 0,
            window.innerWidth || 0
        ));

        return {
            scrollHeight,
            scrollWidth,
            viewportHeight: window.innerHeight || 0,
            viewportWidth: window.innerWidth || 0
        };
    }).catch(() => ({
        scrollHeight: VIEWPORT_HEIGHT,
        scrollWidth: VIEWPORT_WIDTH,
        viewportHeight: VIEWPORT_HEIGHT,
        viewportWidth: VIEWPORT_WIDTH
    }));
}

function readPngDimensions(imagePath) {
    try {
        const data = fs.readFileSync(imagePath);
        const isPng = data.length >= 24 &&
            data[0] === 0x89 &&
            data[1] === 0x50 &&
            data[2] === 0x4e &&
            data[3] === 0x47;
        if (!isPng) return null;

        return {
            width: data.readUInt32BE(16),
            height: data.readUInt32BE(20)
        };
    } catch (e) {
        return null;
    }
}

async function saveViewportScreenshot(page, imagePath) {
    const dir = path.dirname(imagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const originalViewport = page.viewportSize() || { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
    let lastError = null;
    for (let attempt = 1; attempt <= SCREENSHOT_RETRY_ATTEMPTS; attempt++) {
        try {
            await waitForScreenshotReady(page);
            const metrics = await getPageScreenshotMetrics(page);
            const screenshotViewportHeight = Math.min(
                Math.max(metrics.scrollHeight, VIEWPORT_HEIGHT),
                SCREENSHOT_MAX_VIEWPORT_HEIGHT
            );

            await page.setViewportSize({
                width: VIEWPORT_WIDTH,
                height: screenshotViewportHeight
            }).catch(() => {});
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
            await page.waitForTimeout(300);

            const resizedMetrics = await getPageScreenshotMetrics(page);
            await page.screenshot({
                path: imagePath,
                fullPage: true,
                animations: 'disabled',
                caret: 'hide',
                scale: 'css',
                timeout: 30000
            });

            const pngDimensions = readPngDimensions(imagePath);
            if (
                pngDimensions &&
                resizedMetrics.scrollHeight > resizedMetrics.viewportHeight + 20 &&
                pngDimensions.height < resizedMetrics.scrollHeight - 20
            ) {
                throw new Error(`截图高度不足: image=${pngDimensions.height}, page=${resizedMetrics.scrollHeight}`);
            }

            return;
        } catch (e) {
            lastError = e;
            console.log(`[截图] 第 ${attempt} 次截图失败: ${e.message}`);
            await page.waitForTimeout(1000).catch(() => {});
        } finally {
            await page.setViewportSize(originalViewport).catch(() => {});
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        }
    }

    throw lastError;
}

function maskUsernameForLog(username) {
    const value = String(username || '').trim();
    if (!value) return '(empty)';

    const atIndex = value.indexOf('@');
    if (atIndex <= 1) {
        if (value.length <= 3) return `${value[0] || '*'}**`;
        return `${value.slice(0, 1)}***${value.slice(-1)}`;
    }

    const name = value.slice(0, atIndex);
    const domain = value.slice(atIndex + 1);
    const maskedName = name.length <= 2 ? `${name[0] || '*'}*` : `${name.slice(0, 2)}***`;
    return `${maskedName}@${domain}`;
}

function recordUserFailure(failedUsers, user, reason) {
    const username = user && user.username ? user.username : '';
    const maskedUsername = maskUsernameForLog(username);
    failedUsers.push({ username: maskedUsername, reason });
    console.error(`[结果] ${maskedUsername} 失败: ${reason}`);
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            let rawUsers = [];

            if (Array.isArray(parsed)) {
                rawUsers = parsed;
            } else if (parsed && Array.isArray(parsed.users)) {
                rawUsers = parsed.users;
            } else if (parsed && typeof parsed === 'object' && (parsed.username || parsed.password)) {
                rawUsers = [parsed];
            }

            const users = [];
            const seenUsernames = new Set();

            for (const entry of rawUsers) {
                if (!entry || typeof entry !== 'object') {
                    console.log('[用户配置] 跳过无效条目: 非对象。');
                    continue;
                }

                const username = String(entry.username || entry.email || '').trim();
                const password = String(entry.password || '').trim();

                if (!username || !password) {
                    console.log(`[用户配置] 跳过无效条目: username/password 不完整 (${maskUsernameForLog(username)})`);
                    continue;
                }

                const dedupeKey = username.toLowerCase();
                if (seenUsernames.has(dedupeKey)) {
                    console.log(`[用户配置] 跳过重复账号: ${maskUsernameForLog(username)}`);
                    continue;
                }

                seenUsernames.add(dedupeKey);
                users.push({ username, password });
            }

            console.log(`[用户配置] USERS_JSON 原始条目 ${rawUsers.length}，有效用户 ${users.length}`);
            if (users.length > 0) {
                console.log(`[用户配置] 本次执行账号: ${users.map((user) => maskUsernameForLog(user.username)).join(', ')}`);
            }

            return users;
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

// --- 核心辅助：通过 CDP 派发鼠标点击事件 ---
async function dispatchCdpClick(page, x, y) {
    const client = await page.context().newCDPSession(page);
    try {
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100)); // 模拟人手点击延迟
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        console.log(`>> CDP 坐标 (${x.toFixed(2)}, ${y.toFixed(2)}) 点击已发送。`);
        return true;
    } catch (e) {
        console.log('>> CDP 点击失败:', e.message);
        return false;
    } finally {
        await client.detach().catch(() => {});
    }
}

// ==========================================
// ========== 1. TURNSTILE 专区 (登录用) ========
// ==========================================
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> 发现 Turnstile 数据。比例:', data);
                await frame.evaluate(() => { window.__turnstile_data = null; }).catch(() => {});
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                return await dispatchCdpClick(page, clickX, clickY);
            }
        } catch (e) { }
    }
    return false;
}

async function checkTurnstileSuccess(page) {
    try {
        const hasResponseToken = await page.locator('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').evaluateAll(elements => {
            return elements.some(el => el.value && el.value.trim().length > 0);
        });
        if (hasResponseToken) return true;
    } catch (e) { }

    const frames = page.frames();
    for (const f of frames) {
        if (f.url().includes('cloudflare')) {
            try {
                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) return true;
            } catch (e) { }
        }
    }
    return false;
}

async function hasTurnstileFrame(page) {
    try {
        const count = await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').count();
        return count > 0;
    } catch (e) {
        return false;
    }
}

async function solveTurnstileIfPresent(page, stageName = "登录", maxAttempts = 10, waitAfterClick = 5000) {
    console.log(`[${stageName}] 开始检测 Cloudflare Turnstile...`);
    let sawTurnstile = false;
    for (let i = 0; i < maxAttempts; i++) {
        if (await hasTurnstileFrame(page)) sawTurnstile = true;

        if (await checkTurnstileSuccess(page)) {
            console.log(`[${stageName}] ✅ Turnstile 已通过验证。`);
            return true;
        }

        const clicked = await attemptTurnstileCdp(page);
        if (clicked) {
            sawTurnstile = true;
            console.log(`[${stageName}] 已点击 Turnstile，等待验证结果 (${waitAfterClick}ms)...`);
            await page.waitForTimeout(waitAfterClick);

            if (await checkTurnstileSuccess(page)) {
                console.log(`[${stageName}] ✅ Turnstile 验证通过！`);
                return true;
            }
            console.log(`[${stageName}] ⚠️ 点击后验证未通过，继续重试...`);
        }
        if (i < maxAttempts - 1) await page.waitForTimeout(1000);
    }
    if (!sawTurnstile) {
        console.log(`[${stageName}] 未检测到 Turnstile。`);
        return true;
    }
    console.log(`[${stageName}] 检测到 Turnstile，但未能通过验证。`);
    return false;
}


// ==========================================
// ========== 2. ALTCHA 专区 (Renew用) =========
// ==========================================
async function getAltchaStatus(page) {
    try {
        return await page.evaluate(() => {
            const normalize = (value) => {
                if (value == null) return '';
                return String(value).trim();
            };

            const widget = document.querySelector('altcha-widget');
            const altchaInputs = Array.from(document.querySelectorAll('input[name="altcha"], textarea[name="altcha"], input[name*="altcha" i], textarea[name*="altcha" i]'));
            const firstFilledInput = altchaInputs.find((input) => normalize(input.value).length > 0);
            const shadowRoot = widget ? widget.shadowRoot : null;
            const checkbox = shadowRoot ? shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]') : null;

            const stateProp = normalize(widget ? widget.state : '');
            const stateAttr = normalize(widget ? widget.getAttribute('state') : '');
            const valueProp = normalize(widget ? widget.value : '');
            const valueAttr = normalize(widget ? widget.getAttribute('value') : '');
            const hiddenInputValue = normalize(firstFilledInput ? firstFilledInput.value : '');
            const checkboxChecked = checkbox && typeof checkbox.checked === 'boolean' ? checkbox.checked : null;
            const ariaChecked = normalize(checkbox ? checkbox.getAttribute('aria-checked') : '');
            const busyAttr = normalize(widget ? widget.getAttribute('aria-busy') : '');
            const state = stateProp || stateAttr || '';
            const widgetExists = !!widget;
            const tokenInputExists = altchaInputs.length > 0;
            const isSolved = state === 'verified' || valueProp.length > 0 || valueAttr.length > 0 || hiddenInputValue.length > 0;
            const isVerifying = !isSolved && (
                state === 'verifying' ||
                state === 'processing' ||
                state === 'working' ||
                checkboxChecked === true ||
                ariaChecked === 'true' ||
                busyAttr === 'true'
            );

            return {
                widgetExists,
                tokenInputExists,
                solved: isSolved,
                isVerifying,
                state: state || 'unknown',
                hasShadowRoot: !!shadowRoot,
                checkboxChecked,
                ariaChecked,
                relatedInputCount: altchaInputs.length,
                valueLength: Math.max(valueProp.length, valueAttr.length),
                hiddenInputLength: hiddenInputValue.length,
                busy: busyAttr === 'true'
            };
        });
    } catch (e) {
        return {
            widgetExists: false,
            tokenInputExists: false,
            solved: false,
            isVerifying: false,
            state: 'error',
            hasShadowRoot: false,
            checkboxChecked: null,
            ariaChecked: '',
            relatedInputCount: 0,
            valueLength: 0,
            hiddenInputLength: 0,
            busy: false
        };
    }
}

function formatAltchaStatus(status) {
    const checkedText = status.checkboxChecked === null ? 'unknown' : String(status.checkboxChecked);
    const ariaChecked = status.ariaChecked || 'n/a';
    return `widget=${status.widgetExists}, tokenInput=${status.tokenInputExists}, inputs=${status.relatedInputCount}, state=${status.state}, solved=${status.solved}, verifying=${status.isVerifying}, shadow=${status.hasShadowRoot}, checked=${checkedText}, ariaChecked=${ariaChecked}, valueLen=${status.valueLength}, hiddenLen=${status.hiddenInputLength}, busy=${status.busy}`;
}

async function checkAltchaSuccess(page) {
    const status = await getAltchaStatus(page);
    return status.solved;
}

async function attemptAltchaClick(page, currentStatus = null) {
    try {
        const altchaWidget = page.locator('altcha-widget').first();
        if (await altchaWidget.count() > 0) {

            const status = currentStatus || await getAltchaStatus(page);
            if (status.solved) return false;
            if (status.isVerifying) {
                console.log(`>> ALTCHA 正在验证中，跳过重复点击。${formatAltchaStatus(status)}`);
                return false;
            }

            await page.waitForTimeout(500);
            await altchaWidget.scrollIntoViewIfNeeded().catch(() => {});

            let boxInfo = await page.evaluate(() => {
                const widget = document.querySelector('altcha-widget');
                if (!widget) return null;

                const pickClickTarget = (root) => {
                    if (!root) return null;
                    return root.querySelector('input[type="checkbox"], [role="checkbox"], label, button');
                };

                if (widget.shadowRoot) {
                    const target = pickClickTarget(widget.shadowRoot);
                    if (target) {
                        const rect = target.getBoundingClientRect();
                        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: target.tagName };
                    }
                }

                const lightDomTarget = pickClickTarget(widget);
                if (lightDomTarget) {
                    const rect = lightDomTarget.getBoundingClientRect();
                    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: lightDomTarget.tagName };
                }

                const rect = widget.getBoundingClientRect();
                return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: false, tagName: widget.tagName };
            });

            if (boxInfo && boxInfo.width > 0 && boxInfo.height > 0) {
                let clickX, clickY;
                if (boxInfo.isExact) {
                    clickX = boxInfo.x + boxInfo.width / 2;
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 发现 ALTCHA 内部点击目标 <${boxInfo.tagName}>，精确计算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                } else {
                    clickX = boxInfo.x + Math.min(25, Math.max(12, boxInfo.width * 0.15));
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 未获取内部复选框，使用估算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                }

                await dispatchCdpClick(page, clickX, clickY);

                await page.evaluate(() => {
                    const widget = document.querySelector('altcha-widget');
                    if (widget && widget.shadowRoot) {
                        const cb = widget.shadowRoot.querySelector('input[type="checkbox"]');
                        if (cb && !cb.checked) {
                            cb.click();
                        }
                    }
                });

                return true;
            } else {
                console.log('>> 找到了 ALTCHA 元素，但获取不到有效大小，跳过点击。');
            }
        }
    } catch (e) {
        console.log('>> 尝试查找 ALTCHA 时出错:', e.message);
    }
    return false;
}

async function solveAltchaIfPresent(page, stageName = "Renew阶段", maxAttempts = 10, waitAfterClick = 8000) {
    console.log(`[${stageName}] 开始检测 ALTCHA Captcha...`);
    let sawWidget = false;
    let sawRelatedField = false;
    let lastStatusText = '';

    // 先给 widget 一个短暂挂载窗口。只有真实 widget 出现，才进入后续长时间验证流程。
    const widgetAppearTimeout = 5000;
    const widgetAppearStartedAt = Date.now();

    while (Date.now() - widgetAppearStartedAt < widgetAppearTimeout) {
        const precheckStatus = await getAltchaStatus(page);
        sawRelatedField = sawRelatedField || precheckStatus.tokenInputExists;

        const precheckText = formatAltchaStatus(precheckStatus);
        if ((precheckStatus.widgetExists || precheckStatus.tokenInputExists) && precheckText !== lastStatusText) {
            console.log(`[${stageName}] ALTCHA 状态: ${precheckText}`);
            lastStatusText = precheckText;
        }

        if (precheckStatus.solved) {
            console.log(`[${stageName}] ✅ ALTCHA 已通过验证。`);
            return true;
        }

        if (precheckStatus.widgetExists) {
            sawWidget = true;
            break;
        }

        await page.waitForTimeout(500);
    }

    if (!sawWidget) {
        const finalPrecheckStatus = await getAltchaStatus(page);
        sawRelatedField = sawRelatedField || finalPrecheckStatus.tokenInputExists;

        if (finalPrecheckStatus.solved) {
            console.log(`[${stageName}] ✅ ALTCHA 已通过验证。`);
            return true;
        }

        if (!finalPrecheckStatus.widgetExists) {
            const relatedHint = sawRelatedField ? '（仅检测到 ALTCHA 相关字段，未发现可交互 widget）' : '';
            console.log(`[${stageName}] ${widgetAppearTimeout}ms 内未检测到 ALTCHA widget，按无验证码处理${relatedHint}。`);
            return true;
        }

        sawWidget = true;
    }

    const startedAt = Date.now();
    const totalWaitBudget = Math.max(waitAfterClick * maxAttempts, waitAfterClick);
    let clickAttempts = 0;

    while (Date.now() - startedAt < totalWaitBudget) {
        const status = await getAltchaStatus(page);
        if (status.widgetExists) sawWidget = true;
        sawRelatedField = sawRelatedField || status.tokenInputExists;

        const statusText = formatAltchaStatus(status);
        if ((status.widgetExists || status.tokenInputExists) && statusText !== lastStatusText) {
            console.log(`[${stageName}] ALTCHA 状态: ${statusText}`);
            lastStatusText = statusText;
        }

        if (status.solved) {
            console.log(`[${stageName}] ✅ ALTCHA 已通过验证。`);
            return true;
        }

        if (!status.widgetExists) {
            await page.waitForTimeout(1000);
            continue;
        }

        if (status.isVerifying) {
            await page.waitForTimeout(1000);
            continue;
        }

        if (clickAttempts >= maxAttempts) {
            console.log(`[${stageName}] 已达到 ALTCHA 最大点击次数 (${maxAttempts})，继续等待最终结果...`);
            await page.waitForTimeout(1000);
            continue;
        }

        const clicked = await attemptAltchaClick(page, status);
        if (!clicked) {
            await page.waitForTimeout(1000);
            continue;
        }

        clickAttempts += 1;
        console.log(`[${stageName}] 已点击 ALTCHA，等待 PoW 哈希计算完成 (${waitAfterClick}ms)，当前点击 ${clickAttempts}/${maxAttempts}...`);

        const clickStartedAt = Date.now();

        while (Date.now() - clickStartedAt < waitAfterClick) {
            await page.waitForTimeout(1000);

            const followupStatus = await getAltchaStatus(page);
            if (followupStatus.widgetExists) sawWidget = true;
            sawRelatedField = sawRelatedField || followupStatus.tokenInputExists;

            const followupText = formatAltchaStatus(followupStatus);
            if ((followupStatus.widgetExists || followupStatus.tokenInputExists) && followupText !== lastStatusText) {
                console.log(`[${stageName}] ALTCHA 状态: ${followupText}`);
                lastStatusText = followupText;
            }

            if (followupStatus.solved) {
                console.log(`[${stageName}] ✅ ALTCHA 验证通过 (PoW 计算完成)！`);
                return true;
            }

            if (followupStatus.isVerifying) {
                continue;
            }
        }

        const postWaitStatus = await getAltchaStatus(page);
        const postWaitText = formatAltchaStatus(postWaitStatus);
        if ((postWaitStatus.widgetExists || postWaitStatus.tokenInputExists) && postWaitText !== lastStatusText) {
            console.log(`[${stageName}] ALTCHA 状态: ${postWaitText}`);
            lastStatusText = postWaitText;
        }

        if (postWaitStatus.solved) {
            console.log(`[${stageName}] ✅ ALTCHA 验证通过 (PoW 计算完成)！`);
            return true;
        }

        if (postWaitStatus.isVerifying) {
            console.log(`[${stageName}] ALTCHA 仍在 verifying，继续等待验证结果...`);
        } else {
            console.log(`[${stageName}] 等待 ${waitAfterClick}ms 后仍未检测到 token/solved/verifying，准备下一次点击...`);
        }
    }

    if (!sawWidget) {
        console.log(`[${stageName}] 弹窗中未检测到 ALTCHA widget。`);
        return true;
    }

    const finalStatus = await getAltchaStatus(page);
    console.log(`[${stageName}] 检测到 ALTCHA widget，但在 ${Math.ceil((Date.now() - startedAt) / 1000)} 秒内未能通过验证。最终状态: ${formatAltchaStatus(finalStatus)}`);
    return false;
}

// ==========================================
// =============== 主循环执行 =================
// ==========================================
(async () => {
    let browser = null;
    let exitCode = 0;
    const failedUsers = [];

    try {
        const users = getUsers();
        if (users.length === 0) {
            throw new Error('未在 process.env.USERS_JSON 中找到用户');
        }

        if (PROXY_CONFIG && !await checkProxy()) {
            throw new Error('代理连接失败');
        }

        await launchChrome();

        console.log(`正在连接 Chrome...`);
        for (let k = 0; k < 5; k++) {
            try {
                browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
                console.log('连接成功！');
                break;
            } catch (e) {
                console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        if (!browser) throw new Error('无法连接 Chrome');

        const context = browser.contexts()[0];
        if (!context) {
            throw new Error('无法获取浏览器上下文');
        }
        let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        page.setDefaultTimeout(60000);
        await configurePageViewport(page);

        // --- 代理认证处理 ---
        if (PROXY_CONFIG && PROXY_CONFIG.username) {
            console.log('[代理] 设置认证拦截...');
            await context.route('**/*', (route) => {
                route.continue({
                    headers: {
                        ...route.request().headers(),
                        'Proxy-Authorization': 'Basic ' + Buffer.from(`${PROXY_CONFIG.username}:${PROXY_CONFIG.password}`).toString('base64')
                    }
                });
            });
        }

        await page.addInitScript(INJECTED_SCRIPT);

        for (let i = 0; i < users.length; i++) {
            const user = users[i];
            console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

            try {
                if (page.isClosed()) {
                    page = await context.newPage();
                    await page.addInitScript(INJECTED_SCRIPT);
                }

            // 1. 先确保已登出，再访问登录页
            console.log('确保已登出...');
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            
            // 如果访问登录页后被重定向到 dashboard，说明还有 session，先 logout
            if (page.url().includes('dashboard') && !page.url().includes('login')) {
                console.log('Session 仍然有效，正在登出...');
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
                await page.waitForTimeout(2000);
            }
            
            await page.waitForTimeout(3000); 

            // ➡️ 【登录阶段专属】：解决 Turnstile
            const turnstileOk = await solveTurnstileIfPresent(page, "登录阶段", 10, 5000);
            if (!turnstileOk) {
                console.error('   >> ❌ 登录阶段 Turnstile 未通过，跳过当前用户。');
                recordUserFailure(failedUsers, user, '登录阶段 Turnstile 未通过');
                const failPhotoDir = path.join(process.cwd(), 'screenshots');
                if (!fs.existsSync(failPhotoDir)) fs.mkdirSync(failPhotoDir, { recursive: true });
                const failSafe = user.username.replace(/[^a-z0-9]/gi, '_');
                const failScreenshot = path.join(failPhotoDir, `${failSafe}_turnstile_fail.png`);
                try { await saveViewportScreenshot(page, failScreenshot); } catch (e) {}
                await sendTelegramMessage(formatTelegramUserMessage('❌', user.username, '登录阶段 Turnstile 未通过'), failScreenshot);
                continue;
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                
                await page.waitForTimeout(500);
                await page.getByRole('button', { name: 'Login', exact: true }).click();

                // 检查登录错误
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 账号或密码错误`);
                        recordUserFailure(failedUsers, user, '登录失败: 账号或密码错误');
                        const failPhotoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(failPhotoDir)) fs.mkdirSync(failPhotoDir, { recursive: true });
                        const failSafe = user.username.replace(/[^a-z0-9]/gi, '_');
                        const failScreenshot = path.join(failPhotoDir, `${failSafe}_login_fail.png`);
                        try { await saveViewportScreenshot(page, failScreenshot); } catch (e) {}
                        await sendTelegramMessage(formatTelegramUserMessage('❌', user.username, '登录失败: 账号或密码错误'), failScreenshot);
                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('登录操作遇到异常 (可能是已经登录或超时):', e.message);
            }

            // 2. 登录后的操作
            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('未找到 "See" 按钮 (可能登录未成功或界面变动)。');
                recordUserFailure(failedUsers, user, '未找到 See 链接，可能登录未成功或界面变动');
                continue;
            }

            // 3. Renew 逻辑
            let renewSuccess = false;
            let renewFailureReason = `续期失败，${RENEW_MAX_ATTEMPTS}次尝试均未成功`;
            for (let attempt = 1; attempt <= RENEW_MAX_ATTEMPTS; attempt++) {
                if (page.url().includes('login')) {
                    console.log('页面被重定向到登录页，退出 Renew 循环。');
                    break;
                }

                console.log(`\n[尝试 ${attempt}/${RENEW_MAX_ATTEMPTS}] 正在寻找 Renew 按钮...`);
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    // 定位弹窗
                    const modal = page.locator('.modal-content, [role="dialog"]').filter({ hasText: 'Renew' }).first();
                    
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // 晃动鼠标
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew', exact: true });
                    if (await confirmBtn.isVisible()) {
                        
                        const photoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
                        const captchaScreenshotName = `${safeUsername}_ALTCHA_${attempt}.png`;
                        try {
                            await saveViewportScreenshot(page, path.join(photoDir, captchaScreenshotName));
                            console.log(`   >> 弹窗截图已保存: ${captchaScreenshotName}`);
                        } catch (e) {
                            console.log('   >> 截图失败:', e.message);
                        }
                        
                        // ➡️ 【Renew阶段专属】：只处理 ALTCHA Captcha，给 8 秒等待它的 PoW 后台计算
                        const altchaOk = await solveAltchaIfPresent(page, "Renew弹窗", 10, 8000);

                        if (!altchaOk) {
                            renewFailureReason = `续期失败，Renew 阶段 ALTCHA 未通过（已重试 ${RENEW_MAX_ATTEMPTS} 次）`;
                            console.log('   >> ALTCHA 未通过，跳过确认按钮并刷新重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            if (page.url().includes('login')) {
                                console.log('   >> 刷新后被重定向到登录页，退出。');
                                break;
                            }
                            continue;
                        }

                        console.log('   >> 点击弹窗中的 Renew 确认按钮...');
                        await confirmBtn.click();

                        let hasCaptchaError = false;
                        try {
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ 错误: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText().catch(() => '');
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> ⏳ 暂无法续期 (还没到时间)。下次可续期: ${dateStr}`);
                                    renewSuccess = true;

                                    const skipScreenshot = path.join(photoDir, `${safeUsername}_skip.png`);
                                    let modalClosed = false;
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) {
                                            await closeBtn.click();
                                            await modal.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
                                            await page.waitForTimeout(500);
                                            modalClosed = !await modal.isVisible().catch(() => false);
                                        }
                                    } catch (e) {}

                                    if (!modalClosed) {
                                        console.log('   >> Renew 弹窗未能完全关闭，使用当前页面状态截图。');
                                    }

                                    try { await saveViewportScreenshot(page, skipScreenshot); } catch (e) {}
                                    await sendTelegramMessage(formatTelegramUserMessage('⏳', user.username, `暂无法续期，下次可续期时间: ${dateStr}`), skipScreenshot);
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break;

                        if (hasCaptchaError) {
                            renewFailureReason = `续期失败，Renew 阶段 ALTCHA 未通过（已重试 ${RENEW_MAX_ATTEMPTS} 次）`;
                            console.log('   >> 验证码未通过，刷新页面重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            if (page.url().includes('login')) {
                                console.log('   >> 刷新后被重定向到登录页，退出。');
                                break;
                            }
                            continue;
                        }

                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ Renew successful!');
                            const successScreenshot = path.join(photoDir, `${safeUsername}_success.png`);
                            try { await saveViewportScreenshot(page, successScreenshot); } catch (e) {}
                            await sendTelegramMessage(formatTelegramUserMessage('✅', user.username, '续期成功！'), successScreenshot);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框未关闭，刷新重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            if (page.url().includes('login')) {
                                console.log('   >> 刷新后被重定向到登录页，退出。');
                                break;
                            }
                            continue;
                        }
                    } else {
                        await page.reload();
                        await page.waitForTimeout(3000);
                        if (page.url().includes('login')) {
                            console.log('   >> 刷新后被重定向到登录页，退出。');
                            break;
                        }
                        continue;
                    }
                } else {
                    console.log('未找到 Renew 按钮 (可能已结束)。');
                    break;
                }
            } 

            if (!renewSuccess) {
                console.log('   >> ❌ Renew 全部尝试失败。');
                recordUserFailure(failedUsers, user, renewFailureReason);
                const failDir = path.join(process.cwd(), 'screenshots');
                if (!fs.existsSync(failDir)) fs.mkdirSync(failDir, { recursive: true });
                const failSafe = user.username.replace(/[^a-z0-9]/gi, '_');
                const failScreenshot = path.join(failDir, `${failSafe}_renew_fail.png`);
                try { await saveViewportScreenshot(page, failScreenshot); } catch (e) {}
                await sendTelegramMessage(formatTelegramUserMessage('❌', user.username, renewFailureReason), failScreenshot);
            }

        } catch (err) {
            recordUserFailure(failedUsers, user, `处理异常: ${err.message || err}`);
            console.error(`Error processing user:`, err);
        }

        const photoDir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        try {
            await saveViewportScreenshot(page, path.join(photoDir, `${safeUsername}.png`));
        } catch (e) {}

        console.log(`用户处理完成\n`);
    }

        if (failedUsers.length > 0) {
            exitCode = 1;
            console.error(`完成，但 ${failedUsers.length}/${users.length} 个用户处理失败。`);
            for (const failedUser of failedUsers) {
                console.error(` - ${failedUser.username}: ${failedUser.reason}`);
            }
        } else {
            console.log('完成，所有用户处理成功。');
        }
    } catch (err) {
        exitCode = 1;
        console.error('脚本执行失败:', err);
    } finally {
        if (browser) {
            try {
                await browser.close();
                console.log('浏览器已关闭。');
            } catch (e) {
                console.error('关闭浏览器失败:', e.message);
            }
        }
        process.exit(exitCode);
    }
})();
