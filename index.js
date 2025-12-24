/*
 * ============================================
 *  Memory Processor Extension v1.2
 * ============================================
 * 
 * 功能：
 * 1. 拦截生成请求，提取完整历史记录
 * 2. 调用记忆处理 API，转换为攻方主观视角
 * 3. 将处理后的记忆注入变量，供主预设使用
 * 4. 智能缓存，避免重复处理
 * 
 * 使用方式：
 * - 在主预设中使用 {{getvar::processed_memory}}
 * - 或在 Character Card 中使用 {{getvar::processed_memory}}
 */
import { 
    extension_settings, 
    getContext, 
    saveSettingsDebounced,
    eventSource,
    event_types,
    saveSettings
} from "../../../../extensions.js";

import { 
    chat,
    substituteParams
} from "../../../../script.js";

// 使用jQuery，因为SillyTavern依赖它
const $ = jQuery;

// 模块名称
const MODULE_NAME = "memory-processor";

// 1. 初始化设置
const DEFAULT_SETTINGS = {
    enabled: true,
    apiUrl: "https://api.openai.com/v1/chat/completions", 
    apiKey: "",
    model: "gpt-4o-mini",
    maxHistoryMessages: 50,
    cacheThreshold: 3,
    memoryPrompt: `你是一个记忆处理器。你的任务是把角色扮演的对话历史转化为"攻方脑子里记得的事"。

## 核心原则
1. 模拟攻方的主观记忆，不是客观总结
2. 攻方只能记得他看到、听到、感受到的
3. 攻方看不到受方的内心想法
4. 记忆可以带情绪、偏差，这是正常的

## 处理规则

### ✅ 保留（攻方能感知的）
- 受方说的话（攻方听到了）
- 受方的表情、动作、身体反应（攻方看到了）
- 攻方自己做的事和感受
- 场景、地点、时间线

### ❌ 删除（攻方感知不到的）
- 受方的内心独白
- 受方的心理活动
- "他心想..."、"他暗自..."等描写

## 输出格式
用第一人称短句列表输出，每条是一个记忆碎片。
- 使用"我"而不是"攻方"
- 碎片化，不要连续段落
- 带主观情绪
- 按时间顺序

示例：
- 我记得她当时脸红了
- 我说了那句话后她沉默了很久
- 我摸她头发的时候她身体僵了一下
- 我感觉她好像在躲避我的眼神`,
    cachedMemory: "",
    lastProcessedLength: 0
};

// 确保设置被加载
function loadSettings() {
    console.log(`[${MODULE_NAME}] 加载设置`);
    if (!extension_settings[MODULE_NAME]) {
        console.log(`[${MODULE_NAME}] 初始化默认设置`);
        extension_settings[MODULE_NAME] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        saveSettingsDebounced();
    } else {
        // 合并缺失的默认值
        for (const key in DEFAULT_SETTINGS) {
            if (extension_settings[MODULE_NAME][key] === undefined) {
                extension_settings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
            }
        }
    }
    console.log(`[${MODULE_NAME}] 当前设置:`, extension_settings[MODULE_NAME]);
    return extension_settings[MODULE_NAME];
}

// 获取设置
function getSettings() {
    return extension_settings[MODULE_NAME] || loadSettings();
}

// 2. API 调用
async function callMemoryAPI(historyText) {
    const settings = getSettings();
    console.log(`[${MODULE_NAME}] 调用API，历史长度: ${historyText.length}`);
    
    if (!settings.apiUrl || !settings.apiKey) {
        console.warn(`[${MODULE_NAME}] API URL 或 Key 未设置`);
        return null;
    }

    try {
        const response = await fetch(settings.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                model: settings.model,
                messages: [{
                    role: "user", 
                    content: `${settings.memoryPrompt}\n\n━━━━━━━━━━━━━━━━\n以下是对话历史：\n${historyText}\n━━━━━━━━━━━━━━━━\n请输出攻方视角的记忆片段：`
                }],
                max_tokens: 1000,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        console.log(`[${MODULE_NAME}] API响应:`, data);
        
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
            console.warn(`[${MODULE_NAME}] API返回空内容`);
            return null;
        }
        
        console.log(`[${MODULE_NAME}] 成功获取记忆: ${content.substring(0, 50)}...`);
        return content;
    } catch (e) {
        console.error(`[${MODULE_NAME}] API请求失败:`, e);
        return null;
    }
}

// 获取聊天历史
function getChatHistory() {
    try {
        // 方法1: 从全局变量
        if (window.chat && Array.isArray(window.chat)) {
            return window.chat;
        }
        
        // 方法2: 从context
        const context = getContext();
        if (context && context.chat && Array.isArray(context.chat)) {
            return context.chat;
        }
        
        // 方法3: 直接访问
        if (typeof getContext === 'function') {
            const ctx = getContext();
            return ctx?.chat || [];
        }
        
        console.warn(`[${MODULE_NAME}] 无法获取聊天历史`);
        return [];
    } catch (e) {
        console.error(`[${MODULE_NAME}] 获取历史时出错:`, e);
        return [];
    }
}

// 3. 核心逻辑：拦截生成
async function onGenerateBefore() {
    console.log(`[${MODULE_NAME}] 触发生成前事件`);
    
    const settings = getSettings();
    if (!settings.enabled) {
        console.log(`[${MODULE_NAME}] 插件已禁用`);
        return;
    }

    const chatHistory = getChatHistory();
    console.log(`[${MODULE_NAME}] 历史长度: ${chatHistory.length}`);
    
    if (!chatHistory || chatHistory.length === 0) {
        console.log(`[${MODULE_NAME}] 无历史记录`);
        return;
    }

    // 缓存检查
    const lengthDiff = Math.abs(chatHistory.length - settings.lastProcessedLength);
    if (settings.cachedMemory && lengthDiff < settings.cacheThreshold) {
        console.log(`[${MODULE_NAME}] 使用缓存，长度差: ${lengthDiff}`);
        // 注入变量
        injectMemory(settings.cachedMemory);
        return;
    }

    // 格式化历史
    const recentMessages = chatHistory.slice(-settings.maxHistoryMessages);
    const text = recentMessages
        .filter(m => m.mes && m.mes.trim() !== '')
        .map(m => {
            const role = m.is_user ? "【用户/受方】" : "【AI/攻方】";
            const name = m.name || (m.is_user ? "用户" : "AI");
            return `${role} ${name}：\n${m.mes}`;
        })
        .join("\n\n---\n\n");
    
    console.log(`[${MODULE_NAME}] 格式化后的历史长度: ${text.length}`);
    
    // 调用API
    const memory = await callMemoryAPI(text);
    if (memory) {
        // 保存到缓存
        settings.cachedMemory = memory;
        settings.lastProcessedLength = chatHistory.length;
        saveSettingsDebounced();
        
        // 注入变量
        injectMemory(memory);
    }
}

// 注入记忆到变量系统
function injectMemory(memory) {
    console.log(`[${MODULE_NAME}] 注入记忆: ${memory.substring(0, 30)}...`);
    
    // 方法1: 使用全局变量
    if (!window.stVariables) {
        window.stVariables = {};
    }
    window.stVariables.processed_memory = memory;
    
    // 方法2: 尝试设置到context
    try {
        const context = getContext();
        if (context && context.setVariable) {
            context.setVariable("processed_memory", memory);
        } else if (context && context.variables) {
            context.variables["processed_memory"] = memory;
        }
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 无法设置context变量:`, e);
    }
    
    // 方法3: 使用substituteParams系统
    if (typeof substituteParams === 'function') {
        try {
            substituteParams("{{getvar::processed_memory}}");
        } catch (e) {
            // 忽略错误
        }
    }
    
    console.log(`[${MODULE_NAME}] 记忆已注入，可在提示词中使用 {{getvar::processed_memory}}`);
}

// 4. 创建设置UI - 使用标准方式
function createSettingsUI() {
    console.log(`[${MODULE_NAME}] 创建设置UI`);
    
    const settings = getSettings();
    
    // 创建容器
    const container = document.createElement('div');
    container.id = 'memory-processor-settings';
    container.className = 'memory-processor-container';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🧠 记忆处理器 (Memory Processor)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 10px;">
                <div class="memory-processor-settings">
                    <div class="flex-container">
                        <label class="checkbox_label">
                            <input type="checkbox" id="mp-enabled" ${settings.enabled ? 'checked' : ''}>
                            <span>启用记忆处理</span>
                        </label>
                    </div>
                    
                    <div class="margin-top-10">
                        <label>API URL:</label>
                        <input type="text" id="mp-url" class="text_pole" value="${settings.apiUrl || ''}" placeholder="https://api.openai.com/v1/chat/completions">
                    </div>
                    
                    <div class="margin-top-10">
                        <label>API Key:</label>
                        <input type="password" id="mp-key" class="text_pole" value="${settings.apiKey || ''}">
                    </div>
                    
                    <div class="margin-top-10">
                        <label>模型名称:</label>
                        <input type="text" id="mp-model" class="text_pole" value="${settings.model || ''}">
                    </div>

                    <div class="margin-top-10">
                        <label>最大处理历史数:</label>
                        <input type="number" id="mp-max" class="text_pole" min="1" max="200" value="${settings.maxHistoryMessages}">
                    </div>

                    <div class="margin-top-10">
                        <label>缓存阈值:</label>
                        <input type="number" id="mp-cache" class="text_pole" min="0" max="20" value="${settings.cacheThreshold}">
                        <small>历史变化小于此值时使用缓存</small>
                    </div>

                    <div class="margin-top-10">
                        <label>自定义Prompt:</label>
                        <textarea id="mp-prompt" class="text_pole" rows="8" style="width: 100%;">${settings.memoryPrompt}</textarea>
                    </div>

                    <div class="margin-top-10">
                        <button id="mp-clear" class="menu_button">清除缓存</button>
                        <button id="mp-test" class="menu_button">测试API</button>
                        <button id="mp-save" class="menu_button">保存设置</button>
                    </div>
                    
                    <div id="mp-status" style="margin-top:10px; padding:5px; background:var(--SmartThemeBlurTintColor); border-radius:5px; font-size:12px;">
                        状态: 就绪
                    </div>
                </div>
            </div>
        </div>
    `;
    
    return container;
}

// 绑定UI事件
function bindUIEvents() {
    console.log(`[${MODULE_NAME}] 绑定UI事件`);
    
    const settings = getSettings();
    
    // 启用/禁用
    $('#mp-enabled').on('change', function() {
        settings.enabled = $(this).is(':checked');
        saveSettingsDebounced();
        console.log(`[${MODULE_NAME}] 插件${settings.enabled ? '启用' : '禁用'}`);
    });
    
    // API URL
    $('#mp-url').on('input', function() {
        settings.apiUrl = $(this).val();
        saveSettingsDebounced();
    });
    
    // API Key
    $('#mp-key').on('input', function() {
        settings.apiKey = $(this).val();
        saveSettingsDebounced();
    });
    
    // 模型
    $('#mp-model').on('input', function() {
        settings.model = $(this).val();
        saveSettingsDebounced();
    });
    
    // 最大历史数
    $('#mp-max').on('input', function() {
        const val = parseInt($(this).val());
        if (val >= 1 && val <= 200) {
            settings.maxHistoryMessages = val;
            saveSettingsDebounced();
        }
    });
    
    // 缓存阈值
    $('#mp-cache').on('input', function() {
        const val = parseInt($(this).val());
        if (val >= 0 && val <= 20) {
            settings.cacheThreshold = val;
            saveSettingsDebounced();
        }
    });
    
    // Prompt
    $('#mp-prompt').on('input', function() {
        settings.memoryPrompt = $(this).val();
        saveSettingsDebounced();
    });
    
    // 清除缓存
    $('#mp-clear').on('click', function() {
        settings.cachedMemory = "";
        settings.lastProcessedLength = 0;
        saveSettingsDebounced();
        $('#mp-status').html('<span style="color:var(--green);">✅ 缓存已清除</span>');
        console.log(`[${MODULE_NAME}] 缓存已清除`);
    });
    
    // 测试API
    $('#mp-test').on('click', async function() {
        $('#mp-status').html('<span style="color:var(--yellow);">⏳ 正在测试API...</span>');
        
        const testText = "测试消息：你好，这是一条测试消息。";
        const result = await callMemoryAPI(testText);
        
        if (result) {
            $('#mp-status').html(`<span style="color:var(--green);">✅ API测试成功！</span><br>
            <small>响应预览: ${result.substring(0, 100)}...</small>`);
        } else {
            $('#mp-status').html('<span style="color:var(--red);">❌ API测试失败，请检查控制台和API配置</span>');
        }
    });
    
    // 保存设置
    $('#mp-save').on('click', function() {
        saveSettingsDebounced();
        $('#mp-status').html('<span style="color:var(--green);">✅ 设置已保存</span>');
        setTimeout(() => {
            $('#mp-status').text('状态: 就绪');
        }, 2000);
    });
}

// 5. 初始化扩展
jQuery(async function() {
    console.log(`[${MODULE_NAME}] 开始初始化`);
    
    // 等待DOM加载
    await waitForDOM();
    
    // 加载设置
    loadSettings();
    
    // 创建设置面板
    const panel = createSettingsUI();
    
    // 添加到扩展区域
    const extensionsArea = $('#extensions_settings');
    if (extensionsArea.length) {
        extensionsArea.append(panel);
        console.log(`[${MODULE_NAME}] 设置面板已添加`);
    } else {
        // 备用方案
        const target = $('.extensions_menu').first();
        if (target.length) {
            target.after(panel);
        } else {
            $('body').append(panel);
        }
        console.log(`[${MODULE_NAME}] 设置面板已添加到备用位置`);
    }
    
    // 绑定事件
    bindUIEvents();
    
    // 注册事件监听
    eventSource.on(event_types.GENERATION_STARTED, onGenerateBefore);
    
    console.log(`[${MODULE_NAME}] 插件初始化完成`);
});

// 等待DOM加载的辅助函数
function waitForDOM() {
    return new Promise((resolve) => {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', resolve);
        } else {
            resolve();
        }
    });
}

// 导出给扩展系统（如果需要）
if (typeof module !== 'undefined') {
    module.exports = { MODULE_NAME };
}
