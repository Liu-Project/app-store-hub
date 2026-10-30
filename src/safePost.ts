import type { Webview } from 'vscode';

/**
 * 安全地向 webview 发送消息：webview 已销毁（dispose）时 postMessage 会抛异常
 * 或返回 rejected promise（例如详情面板被用户关闭后异步回调仍在继续），
 * 统一吞掉，避免「Webview is disposed」未捕获错误刷屏。
 */
export function safePost(webview: Webview, message: unknown): void {
  try {
    void Promise.resolve(webview.postMessage(message)).catch(() => {
      /* webview 已销毁，忽略 */
    });
  } catch {
    /* webview 已销毁，忽略 */
  }
}
